export function normalizeEndpoint(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入有效的 Base URL。");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("请使用 HTTPS 地址。本机服务也可以使用 HTTP。");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("Base URL 应只包含服务地址和 API 路径。");
  }
  return url.href.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

export async function listModels(endpoint, key, signal) {
  let response;
  try {
    response = await fetch(endpoint + "/models", {
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: key ? { Authorization: "Bearer " + key } : {},
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("无法读取模型列表。请检查 Base URL、网络及服务的跨域设置（CORS）。");
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("模型服务拒绝访问。请检查 API Key 和模型列表权限。");
  }
  if (response.status === 404 || response.status === 405) {
    throw new Error("此地址没有提供模型列表。请检查 Base URL 是否包含正确的 API 路径。");
  }
  if (!response.ok) throw new Error("模型列表请求失败（HTTP " + response.status + "）。");
  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload?.data)) throw new Error("服务返回的模型列表格式不正确。");
  const ids = payload.data.map((model) => model?.id).filter((id) => typeof id === "string" && id.trim());
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}

function providerError(payload) {
  const detail = payload?.error?.message ?? payload?.message ?? payload?.error;
  return typeof detail === "string" ? detail.slice(0, 240) : "";
}

function mergeChoice(payload, append) {
  if (payload.error) throw new Error(providerError(payload) || "模型服务返回错误。");
  const change = payload.choices?.[0]?.delta ?? payload.choices?.[0]?.message;
  if (!change) return;
  const content = typeof change.content === "string"
    ? change.content
    : Array.isArray(change.content) ? change.content.map((block) => block.text || "").join("") : "";
  const reasoning = typeof change.reasoning_content === "string" ? change.reasoning_content
    : typeof change.reasoning === "string" ? change.reasoning : "";
  if (content || reasoning) append(content, reasoning);
}

async function consumeStream(response, append) {
  if (!response.body) throw new Error("模型服务返回了空响应。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let event = [];
  function flush() {
    if (!event.length) return false;
    const data = event.join("\n").trim();
    event = [];
    if (data === "[DONE]") return true;
    if (data) {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new Error("模型服务返回了无效的流式数据。");
      }
      mergeChoice(parsed, append);
    }
    return false;
  }
  function line(text) {
    if (!text) return flush();
    if (text.startsWith("data:")) event.push(text.slice(5).replace(/^ /, ""));
    return false;
  }
  try {
    for (;;) {
      const chunk = await reader.read();
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        if (line(pending.slice(0, newline).replace(/\r$/, ""))) return;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (chunk.done) {
        if (pending) line(pending.replace(/\r$/, ""));
        flush();
        return;
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function generate(settings, messages, signal, append) {
  let response;
  try {
    response = await fetch(settings.endpoint + "/chat/completions", {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + settings.key },
      body: JSON.stringify({ model: settings.model, messages, stream: true }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("无法连接模型服务。请检查 Base URL、网络，以及该服务是否允许浏览器跨域请求（CORS）。");
  }
  const type = response.headers.get("content-type") || "";
  if (!response.ok) {
    const detail = type.includes("json") ? providerError(await response.json().catch(() => null)) : "";
    throw new Error(`模型请求失败（HTTP ${response.status}）。${detail ? " " + detail : ""}`);
  }
  if (type.includes("text/event-stream")) {
    await consumeStream(response, append);
  } else {
    const payload = await response.json().catch(() => null);
    if (!payload) throw new Error("模型服务没有返回 JSON 或流式响应，请检查 Base URL。");
    mergeChoice(payload, append);
  }
}
