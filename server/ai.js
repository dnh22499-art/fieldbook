// Optional AI for receipt reading, project analysis and weekly drafts.
// Two kinds of service can be plugged in (the browser only ever talks to this server):
//   AI_PROVIDER=anthropic  Anthropic's API with the company's key (ANTHROPIC_API_KEY)
//   AI_PROVIDER=openai     any OpenAI-compatible server — e.g. Ollama or LM Studio running
//                          on the NAS / office PC (fully local), or OpenAI itself.
//                          AI_BASE_URL=http://192.168.1.20:11434/v1  AI_MODEL=qwen2.5vl:7b
// With no provider configured the AI buttons say so and everything else works normally.
export const IMAGE_LIMITS = { maxCount: 5, maxInputBytes: 5 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] };
const JSON_ONLY = "Reply with only one JSON value — no prose, no code fences.";
const fail = (message, code, status = 502) => Object.assign(new Error(message), { status, code });

export function createAi(cfg, fetchImpl = (...a) => fetch(...a)) {
  const provider = cfg.aiProvider || (cfg.anthropicKey ? "anthropic" : "");
  const enabled = provider === "anthropic" ? !!cfg.anthropicKey : provider === "openai" ? !!cfg.aiBaseUrl : false;
  const modelFor = (tier) => (tier === "quick" ? cfg.modelQuick : tier === "complex" ? cfg.modelComplex : cfg.model);

  function turnsOf(input) {
    const turns = typeof input === "string" ? [{ role: "user", content: input }] : Array.isArray(input) ? input : null;
    if (!turns || !turns.length) throw fail("Empty request", "bad_request", 400);
    return turns.map((t) => ({ role: t.role === "assistant" ? "assistant" : "user", content: String(t.content ?? "").slice(0, 200000) }));
  }
  const imagesOf = (images) => (images || []).slice(0, IMAGE_LIMITS.maxCount).filter((i) => IMAGE_LIMITS.mediaTypes.includes(i?.mediaType) && typeof i.data === "string");

  // Reads a server-sent-event stream and hands each JSON "data:" payload to onEvent.
  async function readSse(res, onEvent) {
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          let ev; try { ev = JSON.parse(data); } catch { continue; }
          onEvent(ev);
        }
      }
    }
  }
  async function post(url, headers, body, signal) {
    const timeout = AbortSignal.timeout(5 * 60_000);
    const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const code = res.status === 429 || res.status === 529 ? "rate_limited" : res.status === 400 && /image/i.test(t) ? "image_rejected" : "upstream_error";
      throw fail(`AI service ${res.status}: ${t.slice(0, 300)}`, code);
    }
    return res;
  }

  async function anthropic({ input, images, json, modelTier, maxTokens, signal }, onDelta) {
    const turns = turnsOf(input);
    const imgs = imagesOf(images);
    if (imgs.length) turns.at(-1).content = [...imgs.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })), { type: "text", text: turns.at(-1).content }];
    const body = { model: modelFor(modelTier), max_tokens: Math.min(Number(maxTokens) || 4096, 8192), stream: true, messages: turns };
    if (json) body.system = JSON_ONLY;
    const base = (cfg.anthropicBaseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    const res = await post(base + "/v1/messages", { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01" }, body, signal);
    let text = "", stop = "";
    await readSse(res, (ev) => {
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { text += ev.delta.text; onDelta?.(ev.delta.text); }
      else if (ev.type === "message_delta") stop = ev.delta?.stop_reason || stop;
      else if (ev.type === "error") throw fail(ev.error?.message || "AI service error", "upstream_error");
    });
    return { text, truncated: stop === "max_tokens" };
  }

  async function openai({ input, images, json, modelTier, maxTokens, signal }, onDelta) {
    const turns = turnsOf(input);
    const imgs = imagesOf(images);
    if (imgs.length) turns.at(-1).content = [{ type: "text", text: turns.at(-1).content }, ...imgs.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } }))];
    const messages = json ? [{ role: "system", content: JSON_ONLY }, ...turns] : turns;
    const body = { model: modelFor(modelTier), max_tokens: Math.min(Number(maxTokens) || 4096, 8192), stream: true, messages };
    const headers = cfg.aiApiKey ? { authorization: `Bearer ${cfg.aiApiKey}` } : {};
    const res = await post(cfg.aiBaseUrl.replace(/\/+$/, "") + "/chat/completions", headers, body, signal);
    let text = "", stop = "";
    await readSse(res, (ev) => {
      if (ev.error) throw fail(ev.error.message || "AI service error", "upstream_error");
      const c = ev.choices?.[0];
      const d = c?.delta?.content;
      if (typeof d === "string" && d) { text += d; onDelta?.(d); }
      if (c?.finish_reason) stop = c.finish_reason;
    });
    return { text, truncated: stop === "length" };
  }

  return {
    enabled, provider: enabled ? provider : "",
    // Streams text back through onDelta; resolves with the whole text.
    async complete(req, onDelta) {
      if (!enabled) throw fail("AI isn't set up on this server.", "not_granted", 503);
      return provider === "openai" ? openai(req, onDelta) : anthropic(req, onDelta);
    },
  };
}

// First JSON value in a model reply (tolerates stray prose or ``` fences).
export function parseJsonReply(text) {
  const s = String(text || "").replace(/```(?:json)?/g, "").trim();
  try { return JSON.parse(s); } catch {}
  const start = s.search(/[[{]/);
  if (start < 0) return undefined;
  const open = s[start], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch { return undefined; } }
  }
  return undefined;
}
