import { forget, readSaved, saveSettings } from "./storage.js";
import { appendMessage, deleteConversation, exportHistory, importHistory, readMessagePage, rememberChat, setupHistory } from "./history.js";
import { generate, listModels, normalizeEndpoint } from "./transport.js";
import { instructions, loadKnowledge, lookup } from "./knowledge.js";
import { element, formatMarkdown, icon, sourceLink } from "./render.js";

const $ = (id) => document.getElementById(id);
const prompt = $("prompt");
const keyInput = $("api-key");
const endpointInput = $("endpoint");
const modelSelect = $("model");
const refreshModelsButton = $("refresh-models");
const scroll = $("chat-scroll");
const list = $("messages");
const sidebar = $("sidebar");
const olderMessages = $("older-messages");
const historyFile = $("history-file");
const knowledgeToggle = $("knowledge-toggle");
const knowledgeMenu = $("knowledge-menu");
const articles = new Map();
const defaultEndpoint = "https://api.openai.com/v1";
let chats = [];
let active = null;
let view = { messages: [], hasEarlier: false, loading: false };
let settings = null;
let currentJob = null;
let deletion = null;
let storageQueue = Promise.resolve();
let transferringHistory = false;
let initialized = false;
let savingSettings = false;
let modelRequest = null;

function notice(id, text = "") {
  const node = $(id);
  node.textContent = text;
  node.hidden = !text;
}

function queueHistoryWrite(operation) {
  const pending = storageQueue.then(operation);
  storageQueue = pending.catch(() => {});
  return pending;
}

function saveMessages(chat, messages, select = false) {
  const pending = messages.filter((message) =>
    message.sequence === undefined && (message.content || message.reasoning),
  );
  return queueHistoryWrite(async () => {
    for (const message of pending) {
      if (message.sequence !== undefined) continue;
      message.sequence = await appendMessage(chat, message, { create: chat.updatedAt === undefined, select });
      chat.updatedAt = Date.now();
    }
  });
}

function historyWriteError(error) {
  notice("storage-notice", error?.name === "QuotaExceededError"
    ? "浏览器存储空间不足。请导出备份后清理记录。"
    : "对话记录未能保存。请检查浏览器的站点存储权限。");
}

function sidebarOpen(open) {
  sidebar.classList.toggle("open", open);
  $("sidebar-veil").hidden = !open;
  $("toggle-sidebar").setAttribute("aria-expanded", String(open));
}

function setKeyVisibility(show) {
  keyInput.type = show ? "text" : "password";
  const name = show ? "隐藏密钥" : "显示密钥";
  $("toggle-key").setAttribute("aria-label", name);
  $("toggle-key").setAttribute("aria-pressed", String(show));
  $("toggle-key").title = name;
}

function showSettings(open, focus = false) {
  $("settings").hidden = !open;
  $("work-area").classList.toggle("with-settings", open);
  $("toggle-settings").setAttribute("aria-expanded", String(open));
  if (open && focus) (settings ? $("endpoint") : keyInput).focus();
}

function savedKeyFor(endpoint) {
  return settings && endpoint && new URL(endpoint).origin === new URL(settings.endpoint).origin ? settings.key : "";
}

function apiDraft() {
  const endpoint = normalizeEndpoint(endpointInput.value);
  const key = keyInput.value.trim() || savedKeyFor(endpoint);
  if (key && !/^[!-~]+$/.test(key)) throw new Error("API Key 包含空白或其他无效字符。");
  return { endpoint, key };
}

function syncSettingsControls() {
  const loading = Boolean(modelRequest);
  endpointInput.disabled = savingSettings;
  keyInput.disabled = savingSettings;
  modelSelect.disabled = savingSettings || loading || modelSelect.options.length <= 1;
  refreshModelsButton.disabled = !initialized || savingSettings || loading;
  refreshModelsButton.setAttribute("aria-busy", String(loading));
  $("save-settings").disabled = !initialized || savingSettings || loading || !modelSelect.value;
  $("forget-key").disabled = savingSettings;
}

function setModelOptions(ids, selected = "") {
  const placeholder = new Option(ids.length ? "选择模型" : "请先刷新模型列表", "");
  placeholder.disabled = true;
  modelSelect.replaceChildren(placeholder, ...ids.map((id) => new Option(id, id)));
  modelSelect.value = ids.includes(selected) ? selected : "";
  syncSettingsControls();
}

function updateKeyField(savedKey) {
  keyInput.required = !savedKey;
  keyInput.placeholder = savedKey ? "已保存，留空以保留原密钥" : "输入你的 API Key";
}

function clearModelRequest() {
  modelRequest?.abort();
  modelRequest = null;
}

function resetModelOptions() {
  clearModelRequest();
  let endpoint = "";
  try {
    endpoint = normalizeEndpoint(endpointInput.value);
  } catch {
    // Allow partially typed URLs until the user asks for the model list.
  }
  const savedKey = savedKeyFor(endpoint);
  const key = keyInput.value.trim();
  const sameSettings = settings && endpoint === settings.endpoint && (!key || key === savedKey);
  updateKeyField(savedKey);
  setModelOptions(sameSettings ? [settings.model] : [], sameSettings ? settings.model : "");
  notice("settings-error");
  notice("model-status", sameSettings ? "" : "按 Base URL 右侧的按钮获取模型列表。");
}

async function refreshModels() {
  if (!initialized || savingSettings || modelRequest) return;
  notice("settings-error");
  let draft;
  try {
    draft = apiDraft();
  } catch (error) {
    notice("settings-error", error.message);
    return;
  }

  const selected = modelSelect.value;
  const request = new AbortController();
  const timeout = setTimeout(() => request.abort(), 15000);
  modelRequest = request;
  syncSettingsControls();
  notice("model-status", "正在获取模型列表…");

  try {
    const ids = await listModels(draft.endpoint, draft.key, request.signal);
    if (modelRequest !== request) return;
    setModelOptions(ids, selected);
    notice("model-status", ids.length ? "共 " + ids.length + " 个模型" : "服务没有返回可用模型。");
  } catch (error) {
    if (modelRequest !== request) return;
    notice("model-status");
    notice("settings-error", request.signal.aborted ? "获取模型列表超时，请重试。" : error.message);
  } finally {
    clearTimeout(timeout);
    if (modelRequest === request) {
      modelRequest = null;
      syncSettingsControls();
    }
  }
}

function fillSettings(ids = settings ? [settings.model] : []) {
  clearModelRequest();
  endpointInput.value = settings?.endpoint ?? defaultEndpoint;
  keyInput.value = "";
  updateKeyField(settings?.key);
  setModelOptions(ids, settings?.model);
  notice("model-status", settings ? "" : "填写 API Key，刷新后选择模型。");
  $("forget-key").hidden = !settings;
  $("save-settings").textContent = settings ? "保存设置" : "保存并开始";
  setKeyVisibility(false);
  syncComposer();
}

function showKnowledgeMenu(open, restoreFocus = false) {
  knowledgeMenu.hidden = !open;
  knowledgeToggle.setAttribute("aria-expanded", String(open));
  if (restoreFocus) knowledgeToggle.focus();
}

function dismissKnowledgeOutside(event) {
  if (!knowledgeMenu.hidden && !knowledgeToggle.parentElement.contains(event.target)) {
    showKnowledgeMenu(false);
  }
}

knowledgeToggle.onclick = () => showKnowledgeMenu(knowledgeMenu.hidden);
$("knowledge-link").onclick = () => showKnowledgeMenu(false, true);
document.addEventListener("click", dismissKnowledgeOutside);
document.addEventListener("focusin", dismissKnowledgeOutside);

function updateKnowledge() {
  const label = $("knowledge-status");
  return loadKnowledge().then((data) => {
    label.textContent = data.files.length + " 份资料";
    label.title = "版本 " + data.revision.slice(0, 7);
    return data;
  }).catch(() => {
    label.textContent = "知识库暂不可用";
    label.title = "回答将基于模型的通用知识";
    return null;
  });
}

function selectedChat() {
  return chats.find((chat) => chat.id === active);
}

function titleFrom(text) {
  const cleaned = text.trim().replace(/\s+/g, " ");
  const chars = Array.from(cleaned);
  return chars.length > 35 ? chars.slice(0, 34).join("") + "…" : cleaned;
}

function renderHistory() {
  const rows = [];
  for (const chat of chats) {
    const selected = chat.id === active;
    const row = element("div", "history-row" + (selected ? " active" : ""));
    const open = element("button", "history-open");
    open.type = "button";
    open.title = chat.title;
    if (selected) open.setAttribute("aria-current", "true");
    open.append(icon("bubble"), element("span", "", chat.title));
    open.onclick = () => switchChat(chat.id);
    const remove = element("button", "icon-button");
    remove.type = "button";
    remove.title = "删除对话";
    remove.setAttribute("aria-label", "删除对话 " + chat.title);
    remove.append(icon("trash"));
    remove.onclick = () => {
      deletion = chat.id;
      $("delete-title").textContent = chat.title;
      $("delete-dialog").returnValue = "cancel";
      $("delete-dialog").showModal();
    };
    row.append(open, remove);
    rows.push(row);
  }
  $("history").replaceChildren(...rows);
  $("history-empty").hidden = rows.length > 0;
  $("chat-title").textContent = selectedChat()?.title ?? "新建对话";
}

function renderMessage(message) {
  const article = element("article", "message " + message.role);
  article.setAttribute("aria-label", message.role === "user" ? "你的消息" : "回复");
  const body = element("div", "message-body");
  article.append(body);
  if (message.role === "user") {
    body.textContent = message.content;
    return article;
  }
  const reasoning = element("details", "reasoning");
  reasoning.append(element("summary", "", "查看推理"), element("div"));
  const sources = element("div", "sources");
  article.insertBefore(reasoning, body);
  article.append(sources);
  const view = { body, reasoning, sources };
  articles.set(message, view);
  paintAnswer(message, view);
  return article;
}

function paintAnswer(message, view = articles.get(message)) {
  if (!view) return;
  view.reasoning.hidden = !message.reasoning;
  if (view.reasoning.lastElementChild.textContent !== (message.reasoning || "")) {
    view.reasoning.lastElementChild.textContent = message.reasoning || "";
  }
  view.body.replaceChildren(
    message.content ? formatMarkdown(message.content, message.sources)
      : element("p", "message-placeholder", currentJob?.message === message ? "正在生成…" : "暂无回复。"),
  );
  if (view.displayedSources !== message.sources) {
    view.displayedSources = message.sources;
    const items = message.sources ?? [];
    if (items.length) {
      const links = items.map((source, index) => {
        const link = sourceLink(source, "[" + (index + 1) + "] " + source.title + " · " + source.at);
        link.title = source.path + " · " + source.at;
        return link;
      });
      const details = element("details");
      details.append(element("summary", "", "检索到 " + items.length + " 条 RustSBI Agent 资料"), ...links);
      view.sources.replaceChildren(details);
    }
    view.sources.hidden = !items.length;
  }
}

function syncHistoryControls() {
  const disabled = !initialized || transferringHistory || Boolean(currentJob);
  $("import-history").disabled = disabled;
  $("export-history").disabled = disabled || !chats.length;
  olderMessages.hidden = !view.hasEarlier;
  olderMessages.disabled = Boolean(view.readingEarlier);
}

function renderChat() {
  articles.clear();
  const messages = view.messages;
  $("messages-loading").hidden = !view.loading;
  $("welcome").hidden = view.loading || messages.length > 0;
  list.hidden = !messages.length;
  list.replaceChildren(...messages.map(renderMessage));
  renderHistory();
  syncComposer();
  syncHistoryControls();
  scroll.scrollTop = scroll.scrollHeight;
}

async function switchChat(id, remember = true) {
  active = id;
  sidebarOpen(false);
  notice("request-error");
  if (remember) void queueHistoryWrite(() => rememberChat(id)).catch(historyWriteError);
  if (currentJob && currentJob.chatId === id) {
    view = currentJob.view;
    renderChat();
    return;
  }
  const next = { messages: [], hasEarlier: false, loading: Boolean(id) };
  view = next;
  renderChat();
  if (!id) return;
  try {
    // A selection can race a message write while a response is finishing.
    await storageQueue;
    if (view !== next) return;
    Object.assign(next, await readMessagePage(id));
  } catch {
    if (view === next) notice("storage-notice", "无法读取保存的对话记录。");
  } finally {
    next.loading = false;
    if (view === next) renderChat();
  }
}

async function loadEarlier() {
  const target = view;
  const id = active;
  const before = target.messages[0]?.sequence;
  if (!id || !target.hasEarlier || target.readingEarlier || before === undefined) return;
  target.readingEarlier = true;
  syncHistoryControls();
  try {
    const page = await readMessagePage(id, before);
    if (view !== target) return;
    const previousHeight = scroll.scrollHeight;
    const previousTop = scroll.scrollTop;
    target.messages.unshift(...page.messages);
    target.hasEarlier = page.hasEarlier;
    list.prepend(...page.messages.map(renderMessage));
    syncHistoryControls();
    scroll.scrollTop = previousTop + scroll.scrollHeight - previousHeight;
  } catch {
    if (view === target) notice("storage-notice", "无法加载更早的消息。请重试。");
  } finally {
    target.readingEarlier = false;
    if (view === target) syncHistoryControls();
  }
}

function requestContext(messages, current) {
  const result = [];
  let remaining = 24000;
  for (let index = messages.length - 1; index >= 0 && result.length < 16; index--) {
    const { role, content } = messages[index];
    if (!content) continue;
    if (content.length > remaining) break;
    result.unshift({ role, content });
    remaining -= content.length;
  }
  while (result[0]?.role === "assistant") result.shift();
  result.push({ role: "user", content: current });
  return result;
}

function syncComposer() {
  $("model-label").lastElementChild.textContent = settings?.model ?? "尚未连接模型";
  $("toggle-settings").classList.toggle("configured", Boolean(settings));
  $("toggle-settings").title = settings ? settings.model + " · API 设置" : "API 设置";
  const busy = Boolean(currentJob);
  const canStop = busy && currentJob.chatId === active;
  $("send").disabled = !initialized || busy || transferringHistory || view.loading || !prompt.value.trim();
  $("send").hidden = canStop;
  $("stop").hidden = !canStop;
}

function resizePrompt() {
  prompt.style.height = "auto";
  prompt.style.height = Math.min(150, prompt.scrollHeight) + "px";
  syncComposer();
}

async function submit() {
  if (!initialized || currentJob || transferringHistory || view.loading) return;
  const text = prompt.value.trim();
  if (!text) return;
  if (!settings) {
    showSettings(true, true);
    return;
  }
  const existing = selectedChat();
  const chat = existing || { id: crypto.randomUUID(), title: titleFrom(text) };
  chats = [chat, ...chats.filter((item) => item !== chat)];
  active = chat.id;
  const target = view;
  const previous = target.messages.findLast((message) => message.role === "user")?.content || "";
  const context = requestContext(target.messages, text);
  const userMessage = { role: "user", content: text };
  const message = { role: "assistant", content: "", reasoning: "" };
  target.messages.push(userMessage, message);
  const job = { controller: new AbortController(), chatId: chat.id, message, view: target };
  currentJob = job;
  const provider = settings;
  prompt.value = "";
  notice("request-error");
  resizePrompt();
  renderChat();
  const savedUser = saveMessages(chat, target.messages, true).then(() => true, (error) => {
    historyWriteError(error);
    return false;
  });
  let frame;
  function scheduleAnswer() {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 75;
      paintAnswer(message);
      if (follow && active === chat.id) scroll.scrollTop = scroll.scrollHeight;
    });
  }
  try {
    const knowledge = await updateKnowledge();
    if (job.controller.signal.aborted) return;
    const sources = knowledge ? lookup(knowledge, text, previous) : [];
    message.sources = sources.map(({ title, path, at, url }) => ({ title, path, at, url }));
    scheduleAnswer();
    await generate(provider, [{ role: "system", content: instructions(sources) }, ...context], job.controller.signal, (content, reasoning) => {
      message.content += content;
      message.reasoning += reasoning;
      scheduleAnswer();
    });
    if (!message.content.trim() && !message.reasoning.trim()) throw new Error("模型没有返回可显示的内容。");
    $("announcer").textContent = "回答完成";
  } catch (error) {
    if (!job.controller.signal.aborted && active === chat.id) {
      const detail = String(error.message || "模型请求未完成。").replaceAll(provider.key, "••••");
      notice("request-error", detail);
    }
  } finally {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (!message.content && !message.reasoning) {
      target.messages = target.messages.filter((entry) => entry !== message);
      const view = articles.get(message);
      view?.body.closest("article").remove();
      articles.delete(message);
    } else {
      paintAnswer(message);
      const userSaved = await savedUser;
      if (userSaved && !job.deleted && chats.some((item) => item.id === chat.id)) {
        try {
          await saveMessages(chat, [message]);
        } catch (error) {
          historyWriteError(error);
        }
      }
    }
    currentJob = null;
    syncComposer();
    syncHistoryControls();
  }
}

refreshModelsButton.addEventListener("click", refreshModels);
endpointInput.addEventListener("input", resetModelOptions);
keyInput.addEventListener("input", resetModelOptions);
modelSelect.addEventListener("change", syncSettingsControls);

$("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!initialized || savingSettings || modelRequest) return;
  notice("settings-error");
  savingSettings = true;
  syncSettingsControls();
  try {
    const next = { ...apiDraft(), model: modelSelect.value };
    if (!next.key) throw new Error("请填写 API Key。");
    if (!next.model) throw new Error("请刷新模型列表并选择模型。");
    const ids = Array.from(modelSelect.options, (option) => option.value).filter(Boolean);
    await saveSettings(next);
    settings = next;
    fillSettings(ids);
    showSettings(false);
    prompt.focus();
    $("announcer").textContent = "API 设置已保存";
  } catch (error) {
    notice("settings-error", error.message || "无法保存 API 设置。请检查浏览器存储权限。");
  } finally {
    savingSettings = false;
    syncSettingsControls();
  }
});

$("forget-key").onclick = () => {
  try {
    forget("settings");
    settings = null;
    notice("settings-error");
    fillSettings();
    keyInput.focus();
    $("announcer").textContent = "API 设置已移除";
  } catch (error) {
    notice("settings-error", error.message);
  }
};

$("delete-dialog").addEventListener("close", async () => {
  const id = deletion;
  deletion = null;
  if ($("delete-dialog").returnValue !== "delete" || !id) return;
  if (currentJob?.chatId === id) {
    currentJob.deleted = true;
    currentJob.controller.abort();
  }
  try {
    await queueHistoryWrite(() => deleteConversation(id));
    chats = chats.filter((chat) => chat.id !== id);
    if (active === id) void switchChat(null, false);
    else {
      renderHistory();
      syncHistoryControls();
    }
  } catch (error) {
    historyWriteError(error);
  }
});

olderMessages.onclick = loadEarlier;
scroll.addEventListener("scroll", () => {
  if (scroll.scrollTop < 80) void loadEarlier();
}, { passive: true });

async function transferHistory(operation, progress) {
  if (transferringHistory || currentJob) return;
  transferringHistory = true;
  syncHistoryControls();
  syncComposer();
  notice("history-transfer-status", progress);
  try {
    await storageQueue;
    notice("history-transfer-status", await operation());
  } catch (error) {
    notice("history-transfer-status", error?.name === "QuotaExceededError"
      ? "浏览器存储空间不足，导入未完成。"
      : "操作未完成。" + (error?.message || ""));
  } finally {
    transferringHistory = false;
    syncHistoryControls();
    syncComposer();
  }
}

$("export-history").onclick = () => transferHistory(async () => {
  const backup = await exportHistory();
  const file = new Blob([JSON.stringify(backup)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = element("a");
  link.href = url;
  link.download = "rustsbi-agent-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "已导出 " + backup.conversations.length + " 条对话。";
}, "正在导出对话…");

$("import-history").onclick = () => historyFile.click();
historyFile.onchange = () => {
  const file = historyFile.files[0];
  historyFile.value = "";
  if (!file) return;
  void transferHistory(async () => {
    const count = await importHistory(JSON.parse(await file.text()));
    await storageQueue;
    const saved = await setupHistory();
    chats = saved.chats;
    renderHistory();
    if (!active) void switchChat(chats[0]?.id ?? null);
    return "已导入 " + count + " 条对话。";
  }, "正在导入对话…");
};

$("new-chat").onclick = () => {
  switchChat(null);
  prompt.value = "";
  resizePrompt();
  if (!$("settings").hidden && matchMedia("(max-width: 650px)").matches) return;
  prompt.focus();
};
$("toggle-sidebar").onclick = () => sidebarOpen(!sidebar.classList.contains("open"));
$("sidebar-veil").onclick = () => { sidebarOpen(false); $("toggle-sidebar").focus(); };
$("toggle-settings").onclick = () => showSettings($("settings").hidden, $("settings").hidden);
$("close-settings").onclick = () => { showSettings(false); $("toggle-settings").focus(); };
$("toggle-key").onclick = () => setKeyVisibility(keyInput.type === "password");
$("stop").onclick = () => currentJob?.controller.abort();
$("composer").addEventListener("submit", (event) => { event.preventDefault(); void submit(); });
prompt.addEventListener("input", resizePrompt);
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    void submit();
  }
});
document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    prompt.value = button.dataset.prompt;
    resizePrompt();
    prompt.focus();
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!knowledgeMenu.hidden) {
    showKnowledgeMenu(false, true);
  } else if (sidebar.classList.contains("open")) {
    sidebarOpen(false);
    $("toggle-sidebar").focus();
  }
});
matchMedia("(max-width: 900px)").addEventListener("change", () => sidebarOpen(false));

const [savedSettings, savedHistory] = await Promise.allSettled([readSaved("settings"), setupHistory()]);
if (savedSettings.status === "fulfilled") settings = savedSettings.value;
else notice("settings-error", "无法读取保存的 API 设置，请重新填写。");
if (savedHistory.status === "fulfilled") {
  chats = savedHistory.value.chats;
  if (savedHistory.value.migrationFailed) {
    notice("storage-notice", "旧对话迁移失败。请确认浏览器允许站点存储后刷新。");
  }
} else {
  notice("storage-notice", "无法读取保存的对话记录。");
}
initialized = true;
fillSettings();
showSettings(!settings);
void switchChat(savedHistory.value?.active ?? null, false);
void updateKnowledge();
