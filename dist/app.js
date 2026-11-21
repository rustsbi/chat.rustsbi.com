import { forget, readSaved, saveHistory, saveSettings } from "./storage.js";
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
const storageNotice = $("storage-notice");
const storageStatus = element("span");
const dismissStorageLimit = element("button", "icon-button");
dismissStorageLimit.type = "button";
dismissStorageLimit.setAttribute("aria-label", "关闭容量提示");
dismissStorageLimit.append(icon("close"));
storageStatus.setAttribute("role", "status");
storageNotice.removeAttribute("role");
storageNotice.append(storageStatus, dismissStorageLimit);
const articles = new Map();
const defaultEndpoint = "https://api.openai.com/v1";
let chats = [];
let active = null;
let settings = null;
let currentJob = null;
let deletion = null;
let storageQueue = Promise.resolve();
let storageLimitDismissed = false;
let initialized = false;
let savingSettings = false;
let modelRequest = null;

function notice(id, text = "") {
  const node = $(id);
  node.textContent = text;
  node.hidden = !text;
}

function showStorageNotice(text = "", dismissible = false) {
  storageStatus.textContent = text;
  dismissStorageLimit.hidden = !dismissible;
  storageNotice.hidden = !text;
}

dismissStorageLimit.onclick = () => {
  storageLimitDismissed = true;
  showStorageNotice();
};

function persist() {
  const snapshot = structuredClone(chats).map((chat) => ({
    ...chat,
    messages: chat.messages.filter((message) => message.content || message.reasoning),
  }));
  const selected = active;
  storageQueue = storageQueue.catch(() => {}).then(async () => {
    try {
      const limited = await saveHistory(snapshot, selected);
      if (limited && !storageLimitDismissed) {
        showStorageNotice("Cookie 容量有限。本次仅保存近期消息，刷新后可能看不到较早的内容。", true);
      } else {
        showStorageNotice();
      }
    } catch {
      showStorageNotice("对话记录未能保存。请检查浏览器的 Cookie 和存储权限。");
    }
  });
  return storageQueue;
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

function updateKnowledge() {
  const label = $("knowledge-status");
  return loadKnowledge().then((data) => {
    label.textContent = "RustSBI Agent 知识库";
    label.title = data.files.length + " 份资料，版本 " + data.revision.slice(0, 7);
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

function renderChat() {
  articles.clear();
  const messages = selectedChat()?.messages ?? [];
  $("welcome").hidden = messages.length > 0;
  list.hidden = !messages.length;
  list.replaceChildren(...messages.map(renderMessage));
  renderHistory();
  syncComposer();
  scroll.scrollTop = scroll.scrollHeight;
}

function switchChat(id) {
  active = id;
  sidebarOpen(false);
  notice("request-error");
  renderChat();
  void persist();
}

function syncComposer() {
  $("model-label").lastElementChild.textContent = settings?.model ?? "尚未连接模型";
  $("toggle-settings").classList.toggle("configured", Boolean(settings));
  $("toggle-settings").title = settings ? settings.model + " · API 设置" : "API 设置";
  const busy = Boolean(currentJob);
  const canStop = busy && currentJob.chatId === active;
  $("send").disabled = !initialized || busy || !prompt.value.trim();
  $("send").hidden = canStop;
  $("stop").hidden = !canStop;
}

function resizePrompt() {
  prompt.style.height = "auto";
  prompt.style.height = Math.min(150, prompt.scrollHeight) + "px";
  syncComposer();
}

async function submit() {
  if (!initialized || currentJob) return;
  const text = prompt.value.trim();
  if (!text) return;
  if (!settings) {
    showSettings(true, true);
    return;
  }
  let chat = selectedChat();
  if (!chat) chat = { id: crypto.randomUUID(), title: titleFrom(text), messages: [] };
  chats = [chat, ...chats.filter((item) => item !== chat)];
  active = chat.id;
  const previous = chat.messages.findLast((message) => message.role === "user")?.content || "";
  chat.messages.push({ role: "user", content: text });
  const context = chat.messages.filter((message) => message.content).map(({ role, content }) => ({ role, content }));
  const message = { role: "assistant", content: "", reasoning: "" };
  chat.messages.push(message);
  const job = { controller: new AbortController(), chatId: chat.id, message };
  currentJob = job;
  const provider = settings;
  prompt.value = "";
  notice("request-error");
  resizePrompt();
  renderChat();
  void persist();
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
      chat.messages = chat.messages.filter((entry) => entry !== message);
      const view = articles.get(message);
      view?.body.closest("article").remove();
      articles.delete(message);
    } else {
      paintAnswer(message);
    }
    currentJob = null;
    syncComposer();
    void persist();
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

$("delete-dialog").addEventListener("close", () => {
  const target = deletion;
  deletion = null;
  if ($("delete-dialog").returnValue !== "delete" || !target) return;
  if (currentJob?.chatId === target) currentJob.controller.abort();
  chats = chats.filter((chat) => chat.id !== target);
  if (active === target) switchChat(null);
  else {
    renderHistory();
    void persist();
  }
});

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
  if (event.key === "Escape" && sidebar.classList.contains("open")) {
    sidebarOpen(false);
    $("toggle-sidebar").focus();
  }
});
matchMedia("(max-width: 900px)").addEventListener("change", () => sidebarOpen(false));

const [savedSettings, savedHistory] = await Promise.allSettled([readSaved("settings"), readSaved("history")]);
if (savedSettings.status === "fulfilled") settings = savedSettings.value;
else notice("settings-error", "无法读取保存的 API 设置，请重新填写。");
if (savedHistory.status === "fulfilled" && savedHistory.value) {
  chats = savedHistory.value.chats;
  active = savedHistory.value.active;
} else if (savedHistory.status === "rejected") {
  showStorageNotice("无法读取保存的对话记录。");
}
initialized = true;
fillSettings();
showSettings(!settings);
renderChat();
void updateKnowledge();
