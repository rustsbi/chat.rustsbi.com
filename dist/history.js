import { browserKey, forget, readSaved } from "./storage.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const databaseName = "rustsbi-history";
const historyStores = ["conversations", "messages", "meta"];
const backupFormat = "rustsbi-agent-history";
const pageSize = 50;

function openHistory() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore("conversations", { keyPath: "id" });
      db.createObjectStore("messages", { keyPath: ["chatId", "sequence"] });
      db.createObjectStore("meta");
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function resultOf(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(stores, mode, operation) {
  const db = await openHistory();
  try {
    const transaction = db.transaction(stores, mode);
    const completed = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error("对话事务已中止。"));
    });
    // Queue requests synchronously or from IDB callbacks. Encrypt outside the transaction.
    let result;
    try {
      result = operation(transaction);
    } catch (error) {
      result = Promise.reject(error);
    }
    const work = Promise.resolve(result).catch((error) => {
      try { transaction.abort(); } catch {}
      throw error;
    });
    return (await Promise.all([work, completed]))[0];
  } finally {
    db.close();
  }
}

function encryptionData(kind, id) {
  return encoder.encode(JSON.stringify([databaseName, kind, id]));
}

async function seal(kind, id, value) {
  const key = await browserKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encryptionData(kind, id) }, key, encoder.encode(JSON.stringify(value)),
  );
  return { iv, ciphertext };
}

async function unseal(kind, id, record) {
  const key = await browserKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: record.iv, additionalData: encryptionData(kind, id) }, key, record.ciphertext,
  );
  return JSON.parse(decoder.decode(plaintext));
}

function messageRange(chatId, before = Infinity) {
  return IDBKeyRange.bound([chatId, 0], [chatId, before], false, true);
}

function serializableMessage({ role, content, reasoning, sources }) {
  return { role, content, ...(reasoning ? { reasoning } : {}), ...(sources?.length ? { sources } : {}) };
}

async function openConversation(record) {
  return { id: record.id, updatedAt: record.updatedAt, title: await unseal("title", record.id, record.title) };
}

async function openMessage(record) {
  const message = await unseal("message", [record.chatId, record.id], record.payload);
  return { ...message, sequence: record.sequence };
}

async function makeConversation(chat) {
  const messages = [];
  for (const message of chat.messages) {
    const id = crypto.randomUUID();
    const payload = await seal("message", [chat.id, id], serializableMessage(message));
    messages.push({ chatId: chat.id, sequence: messages.length, id, payload });
  }
  const title = await seal("title", chat.id, chat.title);
  return {
    record: { id: chat.id, title, updatedAt: chat.updatedAt, nextSequence: messages.length },
    messages,
  };
}

async function migrateCookies() {
  const legacy = await readSaved("history");
  if (!legacy) return;
  const started = Date.now();
  const converted = [];
  for (const [index, chat] of legacy.chats.entries()) {
    converted.push(await makeConversation({ ...chat, updatedAt: started - index }));
  }
  await transact(historyStores, "readwrite", async (tx) => {
    const meta = tx.objectStore("meta");
    if (await resultOf(meta.get("legacyImported"))) return;
    const conversations = tx.objectStore("conversations");
    const messages = tx.objectStore("messages");
    for (const entry of converted) {
      if (await resultOf(conversations.getKey(entry.record.id)) !== undefined) continue;
      conversations.add(entry.record);
      for (const message of entry.messages) messages.add(message);
    }
    if (await resultOf(meta.get("active")) === undefined) {
      const activeExists = legacy.active && await resultOf(conversations.getKey(legacy.active)) !== undefined;
      meta.put(activeExists ? legacy.active : null, "active");
    }
    meta.put(true, "legacyImported");
  });
  forget("history");
}

export async function setupHistory() {
  let migrationFailed = false;
  try {
    await migrateCookies();
  } catch {
    migrationFailed = true;
  }
  const [records, active] = await transact(["conversations", "meta"], "readonly", (tx) => Promise.all([
    resultOf(tx.objectStore("conversations").getAll()),
    resultOf(tx.objectStore("meta").get("active")),
  ]));
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  const chats = await Promise.all(records.map(openConversation));
  return { chats, active: chats.some((chat) => chat.id === active) ? active : null, migrationFailed };
}

export function rememberChat(id) {
  return transact(["meta"], "readwrite", (tx) => tx.objectStore("meta").put(id, "active"));
}

export async function readMessagePage(chatId, before = Infinity) {
  if (before <= 0) return { messages: [], hasEarlier: false };
  const records = await transact(["messages"], "readonly", (tx) => new Promise((resolve, reject) => {
    const items = [];
    const cursor = tx.objectStore("messages").openCursor(messageRange(chatId, before), "prev");
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      if (!cursor.result || items.length > pageSize) {
        resolve(items);
        return;
      }
      items.push(cursor.result.value);
      cursor.result.continue();
    };
  }));
  const hasEarlier = records.length > pageSize;
  if (hasEarlier) records.pop();
  const messages = await Promise.all(records.reverse().map(openMessage));
  return { messages, hasEarlier };
}

export async function appendMessage(chat, message, { create = false, select = false } = {}) {
  const id = crypto.randomUUID();
  const payload = await seal("message", [chat.id, id], serializableMessage(message));
  const title = create ? await seal("title", chat.id, chat.title) : null;
  return transact(historyStores, "readwrite", async (tx) => {
    const conversations = tx.objectStore("conversations");
    const existing = await resultOf(conversations.get(chat.id));
    if (!existing && !create) throw new Error("这条对话已被删除或未能保存。");
    const record = existing || { id: chat.id, title, nextSequence: 0 };
    const sequence = record.nextSequence++;
    record.updatedAt = Date.now();
    tx.objectStore("messages").add({ chatId: chat.id, sequence, id, payload });
    conversations.put(record);
    if (select) tx.objectStore("meta").put(chat.id, "active");
    return sequence;
  });
}

export function deleteConversation(id) {
  return transact(historyStores, "readwrite", async (tx) => {
    tx.objectStore("conversations").delete(id);
    tx.objectStore("messages").delete(messageRange(id));
    const meta = tx.objectStore("meta");
    if (await resultOf(meta.get("active")) === id) meta.put(null, "active");
  });
}

export async function exportHistory() {
  const [records, rows] = await transact(["conversations", "messages"], "readonly", (tx) => Promise.all([
    resultOf(tx.objectStore("conversations").getAll()),
    resultOf(tx.objectStore("messages").getAll()),
  ]));
  const byId = new Map();
  const conversations = [];
  for (const record of records) {
    const chat = { ...await openConversation(record), messages: [] };
    byId.set(chat.id, chat);
    conversations.push(chat);
  }
  for (const row of rows) byId.get(row.chatId)?.messages.push(serializableMessage(await openMessage(row)));
  conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  return { format: backupFormat, version: 1, conversations };
}

function parseBackupMessage(message) {
  if (!["user", "assistant"].includes(message?.role) || typeof message.content !== "string" ||
      (message.reasoning !== undefined && typeof message.reasoning !== "string") ||
      (message.sources !== undefined && !Array.isArray(message.sources))) {
    throw new Error("备份中的消息格式不正确。");
  }
  const sources = message.sources?.map((source) => {
    if (!source || ["title", "path", "at", "url"].some((field) => typeof source[field] !== "string") ||
        !source.url.startsWith("https://")) {
      throw new Error("备份中的来源链接格式不正确。");
    }
    const { title, path, at, url } = source;
    return { title, path, at, url };
  });
  return serializableMessage({ ...message, sources });
}

export async function importHistory(backup) {
  if (backup?.format !== backupFormat || backup.version !== 1 || !Array.isArray(backup.conversations)) {
    throw new Error("请选择 RustSBI Agent 导出的对话备份。");
  }
  const entries = [];
  for (const chat of backup.conversations) {
    if (typeof chat?.title !== "string" || !Array.isArray(chat.messages)) {
      throw new Error("备份中的对话格式不正确。");
    }
    entries.push(await makeConversation({
      id: crypto.randomUUID(),
      title: chat.title,
      updatedAt: Number.isFinite(chat.updatedAt) ? chat.updatedAt : Date.now(),
      messages: chat.messages.map(parseBackupMessage),
    }));
  }
  await transact(["conversations", "messages"], "readwrite", (tx) => {
    for (const { record, messages } of entries) {
      tx.objectStore("conversations").add(record);
      for (const message of messages) tx.objectStore("messages").add(message);
    }
  });
  return entries.length;
}
