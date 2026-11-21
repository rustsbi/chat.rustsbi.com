const secure = location.protocol === "https:";
const prefix = secure ? "__Host-rsbi-" : "rsbi-";
const cookieLimit = 3600;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let keyPromise;

function subtleCrypto() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("请通过 HTTPS 或 localhost 打开页面，才能加密保存 API Key 和对话。");
  return subtle;
}

function cookie(name) {
  const start = prefix + name + "=";
  return document.cookie.split(/;\s*/).find((part) => part.startsWith(start))?.slice(start.length);
}

function writeCookie(name, value, age) {
  document.cookie = `${prefix}${name}=${value}; Path=/; Max-Age=${age}; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function forget(name) {
  writeCookie(name, "", 0);
  if (cookie(name) !== undefined) throw new Error("浏览器未能移除 Cookie。");
}

function browserKey() {
  keyPromise ??= openKey().catch((error) => {
    keyPromise = undefined;
    throw error;
  });
  return keyPromise;
}

async function openKey() {
  const existing = await new Promise((resolve, reject) => {
    const open = indexedDB.open("rustsbi-chat", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("encryption");
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("浏览器存储被占用。"));
    open.onsuccess = () => resolve(open.result);
  });
  try {
    const key = await new Promise((resolve, reject) => {
      const request = existing.transaction("encryption").objectStore("encryption").get("cookie");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (key) return key;
    const candidate = await subtleCrypto().generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return await new Promise((resolve, reject) => {
      const transaction = existing.transaction("encryption", "readwrite");
      const store = transaction.objectStore("encryption");
      const request = store.get("cookie");
      let saved;
      request.onsuccess = () => {
        saved = request.result || candidate;
        if (!request.result) store.add(saved, "cookie");
      };
      transaction.oncomplete = () => resolve(saved);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    existing.close();
  }
}

function base64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function seal(name, value) {
  const subtle = subtleCrypto();
  let bytes = encoder.encode(JSON.stringify(value));
  let codec = "j";
  if (name === "history" && typeof CompressionStream === "function" && typeof DecompressionStream === "function") {
    const compressed = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
    codec = "g";
  }
  if (bytes.length > 2650) return "";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(name) }, await browserKey(), bytes,
  ));
  const envelope = new Uint8Array(iv.length + encrypted.length);
  envelope.set(iv);
  envelope.set(encrypted, iv.length);
  return codec + base64(envelope);
}

function commit(name, sealed) {
  if (!sealed || sealed.length > cookieLimit) throw new Error("内容超过浏览器 Cookie 的容量。");
  writeCookie(name, sealed, 60 * 60 * 24 * 30);
  if (cookie(name) !== sealed) throw new Error("Cookie 写入失败。请检查浏览器的存储权限。");
}

export async function readSaved(name) {
  const value = cookie(name);
  if (value === undefined) return null;
  const bytes = Uint8Array.from(atob(value.slice(1).replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  let clear = await subtleCrypto().decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(name) }, await browserKey(), bytes.slice(12),
  );
  if (value[0] === "g") {
    clear = await new Response(new Blob([clear]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  }
  return JSON.parse(decoder.decode(clear));
}

export async function saveSettings(settings) {
  commit("settings", await seal("settings", settings));
}

export async function saveHistory(history, active) {
  const snapshot = { active, chats: history };
  let limited = false;
  for (;;) {
    const sealed = await seal("history", snapshot);
    if (sealed && sealed.length <= cookieLimit) {
      commit("history", sealed);
      return limited;
    }
    limited = true;
    const latest = snapshot.chats[0];
    if (!latest) throw new Error("浏览器未能保存对话记录。");
    const oldest = snapshot.chats.at(-1);
    if (oldest !== latest && oldest.id !== active) {
      snapshot.chats.pop();
      continue;
    }
    const other = snapshot.chats.findLastIndex((chat, index) => index > 0 && chat.id !== active);
    if (other !== -1) {
      snapshot.chats.splice(other, 1);
      continue;
    }
    if (oldest.messages.length > 2) {
      oldest.messages.splice(0, oldest.messages[0].role === "user" ? 2 : 1);
      continue;
    }
    if (oldest !== latest) {
      snapshot.chats.pop();
      snapshot.active = null;
      continue;
    }
    const message = oldest.messages.find((item) => item.reasoning?.length || item.sources?.length);
    if (message) {
      delete message.reasoning;
      delete message.sources;
      continue;
    }
    const longest = oldest.messages.reduce((result, item) => item.content.length > (result?.content.length || 0) ? item : result, null);
    if (longest?.content.length > 40) {
      longest.content = longest.content.slice(0, Math.floor(longest.content.length / 2)) + "\n…（保存时截断）";
      continue;
    }
    throw new Error("浏览器未能保存对话记录。");
  }
}
