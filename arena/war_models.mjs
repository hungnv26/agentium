// Model calls in the providers' own APIs (copied from Outpost Zero's tools/war_models.mjs).
// The battle service and the War HQ's Hermes speak the OpenAI chat format to the key gateway
// (tools/arena_setup.mjs). For the two big providers the gateway translates each call:
// - Claude: Anthropic's Messages API, with prompt caching (the briefing and tools, and each
//   conversation's history, are read from cache at a tenth of the price or less) and the battle's
//   thinking effort ("medium": normal);
// - OpenAI's reasoning models: the Responses API, the only one where they take tools while they
//   reason (chat completions wanted reasoning off), at the same effort; OpenAI caches by itself.
// A reply carries the provider's own content back in "x_native" (Claude's thinking blocks, OpenAI's
// reasoning items, with the tool calls); Hermes returns the message unchanged inside a turn's tool
// loop, and the next call sends that content as it was, so the model keeps its reasoning between
// tool calls and the conversation stays byte-identical (which caching and Claude's check of
// replayed thinking both need). Everything else (OpenRouter, Ollama) stays on chat completions.

export const WAR_EFFORT = "medium"; // the same thinking effort for every side
export const WAR_MAX_TOKENS = 16_000; // room for the thinking and the reply

const parseArgs = (s) => {
  try {
    const v = JSON.parse(s || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("") : c == null ? "" : String(c));

// Hermes adds a "[System Information]" block to every sub-agent call's system text: the current
// time to the second (which changes the start of every call and so empties the prompt cache after
// the tools) and boilerplate about web search, sports betting and trading. A commander needs none
// of it; the War HQ's calls go without it (the same for every side).
export function withoutHermesBoilerplate(body) {
  const strip = (t) => (typeof t === "string" ? t.replace(/\n*\[System Information\]:[\s\S]*?(?=\n\n\[LANGUAGE DIRECTIVE\]|$)/, "") : t);
  return { ...body, messages: (body.messages ?? []).map((m) => (m.role === "system" ? { ...m, content: strip(m.content) } : m)) };
}

// ---- Claude ----

export function toAnthropic(body, model) {
  const system = [];
  const messages = [];
  const push = (role, blocks) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };
  for (const m of body.messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      const t = text(m.content).trim();
      if (t) system.push(t);
    } else if (m.role === "user") {
      push("user", [{ type: "text", text: text(m.content) || "(empty)" }]);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: String(m.tool_call_id ?? ""), content: text(m.content) || "(no output)" }]);
    } else if (m.role === "assistant") {
      if (Array.isArray(m.x_native) && m.x_native.length) {
        push("assistant", m.x_native);
        continue;
      }
      const blocks = [];
      const t = text(m.content).trim();
      if (t) blocks.push({ type: "text", text: t });
      for (const c of m.tool_calls ?? []) blocks.push({ type: "tool_use", id: String(c.id), name: String(c.function?.name ?? ""), input: parseArgs(c.function?.arguments) });
      push("assistant", blocks.length ? blocks : [{ type: "text", text: "(no reply)" }]);
    }
  }
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(start)" }] });
  const tools = (body.tools ?? []).map((t) => ({ name: t.function.name, description: t.function.description ?? "", input_schema: t.function.parameters ?? { type: "object", properties: {} } }));
  const out = {
    model,
    max_tokens: WAR_MAX_TOKENS,
    // Cached: the tools and the briefing (one breakpoint after the system text covers both), and
    // the conversation so far (the top-level marker caches up to the last block).
    cache_control: { type: "ephemeral" },
    system: system.length ? [{ type: "text", text: system.join("\n\n"), cache_control: { type: "ephemeral" } }] : undefined,
    messages,
    output_config: { effort: WAR_EFFORT },
  };
  if (tools.length) {
    out.tools = tools;
    out.tool_choice = { type: "auto" };
  }
  return out;
}

export function fromAnthropic(r) {
  const content = Array.isArray(r.content) ? r.content : [];
  const reply = content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const calls = content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const u = r.usage ?? {};
  const cached = u.cache_read_input_tokens ?? 0;
  const written = u.cache_creation_input_tokens ?? 0;
  const input = u.input_tokens ?? 0;
  const finish = { tool_use: "tool_calls", end_turn: "stop", stop_sequence: "stop", max_tokens: "length", refusal: "refusal" }[r.stop_reason] ?? "stop";
  return {
    id: r.id,
    object: "chat.completion",
    model: r.model,
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: reply || (r.stop_reason === "refusal" ? "(declined)" : null), ...(calls.length ? { tool_calls: calls } : {}), x_native: content } }],
    usage: { prompt_tokens: input + cached + written, completion_tokens: u.output_tokens ?? 0, total_tokens: input + cached + written + (u.output_tokens ?? 0), x_input: input, x_cache_read: cached, x_cache_write: written },
  };
}

// Without the thinking blocks: for a retry when Claude refuses replayed thinking (a changed history).
export function withoutThinking(req) {
  return { ...req, messages: req.messages.map((m) => (m.role === "assistant" ? { ...m, content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") } : m)).filter((m) => m.content.length) };
}

// ---- OpenAI (Responses API) ----

export function toResponses(body, model, cacheKey) {
  const instructions = [];
  const input = [];
  for (const m of body.messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      const t = text(m.content).trim();
      if (t) instructions.push(t);
    } else if (m.role === "user") {
      input.push({ role: "user", content: text(m.content) || "(empty)" });
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: String(m.tool_call_id ?? ""), output: text(m.content) || "(no output)" });
    } else if (m.role === "assistant") {
      if (Array.isArray(m.x_native) && m.x_native.length) {
        input.push(...m.x_native);
        continue;
      }
      const t = text(m.content).trim();
      if (t) input.push({ role: "assistant", content: t });
      for (const c of m.tool_calls ?? []) input.push({ type: "function_call", call_id: String(c.id), name: String(c.function?.name ?? ""), arguments: String(c.function?.arguments ?? "{}") });
    }
  }
  const tools = (body.tools ?? []).map((t) => ({ type: "function", name: t.function.name, description: t.function.description ?? "", parameters: t.function.parameters ?? { type: "object", properties: {} }, strict: false }));
  return {
    model,
    instructions: instructions.join("\n\n") || undefined,
    input,
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
    reasoning: { effort: WAR_EFFORT },
    // Not stored at OpenAI: the reasoning comes back encrypted and is sent along next time.
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: WAR_MAX_TOKENS,
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
  };
}

export function fromResponses(r) {
  const output = Array.isArray(r.output) ? r.output : [];
  const reply = output
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("");
  const calls = output.filter((o) => o.type === "function_call").map((o) => ({ id: o.call_id, type: "function", function: { name: o.name, arguments: o.arguments ?? "{}" } }));
  const u = r.usage ?? {};
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const finish = calls.length ? "tool_calls" : r.status === "incomplete" && r.incomplete_details?.reason === "max_output_tokens" ? "length" : "stop";
  return {
    id: r.id,
    object: "chat.completion",
    model: r.model,
    choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: reply || null, ...(calls.length ? { tool_calls: calls } : {}), x_native: output } }],
    usage: { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0), x_input: (u.input_tokens ?? 0) - cached, x_cache_read: cached, x_cache_write: 0 },
  };
}

// ---- cost ----

// What one call cost, from design/model_prices.json (USD per million tokens; null when unknown).
export function callCost(prices, spec, usage) {
  const p = prices?.[spec];
  if (!p || !usage) return null;
  const input = usage.x_input ?? usage.prompt_tokens ?? 0;
  const cached = usage.x_cache_read ?? 0;
  const written = usage.x_cache_write ?? 0;
  const out = usage.completion_tokens ?? 0;
  return (input * p.in + cached * (p.cacheRead ?? p.in) + written * (p.cacheWrite ?? p.in) + out * p.out) / 1e6;
}
