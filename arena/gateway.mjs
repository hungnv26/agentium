// The key gateway (adapted from Outpost Zero's tools/arena_setup.mjs): one model call for an
// Agentium side, "provider:model", on the provider's own API. Claude goes through Anthropic's
// Messages API (prompt caching, thinking effort) and OpenAI's reasoning models through the
// Responses API; everything else (OpenRouter, Ollama) through chat completions (war_models.mjs).
// Keys live in files, one per provider (ARENA_KEYS_DIR, default arena/keys/<provider>.key,
// gitignored), and never leave this process.
//
// In-process: arenaCall(spec, body) for the match service's commanders.
// Over HTTP (startGateway): POST /llm/arena/v1/chat/completions with the arena token, for the
// in-game advisor and any external commander; GET /health, /keys, /usage, /models?provider=...;
// PUT /keys/<provider> with the key as the body (from the setup page on this Mac only).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callCost, fromAnthropic, fromResponses, toAnthropic, toResponses, WAR_MAX_TOKENS, withoutThinking } from "./war_models.mjs";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const GATEWAY_PORT = Number(process.env.GATEWAY_PORT ?? 8895);
const KEYS_DIR = process.env.ARENA_KEYS_DIR ? process.env.ARENA_KEYS_DIR.replace(/^~/, process.env.HOME ?? "") : join(ROOT, "keys");
const OLLAMA_BASE = process.env.OLLAMA_BASE ?? "http://127.0.0.1:11434/v1";

export const PROVIDERS = {
  ollama: { name: "Local (Ollama)", base: null, models: ["qwen3.5:4b"] },
  anthropic: { name: "Anthropic (Claude)", base: "https://api.anthropic.com/v1", models: ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-fable-5-1"] },
  openai: { name: "OpenAI", base: "https://api.openai.com/v1", models: ["gpt-5", "gpt-5-mini", "gpt-4.1"] },
  openrouter: { name: "OpenRouter", base: "https://openrouter.ai/api/v1", models: ["anthropic/claude-sonnet-5-5", "openai/gpt-5"] },
};
// OpenAI models that reason: tools only on the Responses API.
const OPENAI_REASONING = /^(o[1-9]|gpt-5|gpt-6|gpt-[7-9])/;

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");
function writeSecret(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

// The arena token: the match service and the advisor send it with every gateway call. Read from
// ARENA_TOKEN, else kept in .data/arena.token (generated once).
export function arenaToken() {
  if (process.env.ARENA_TOKEN) return process.env.ARENA_TOKEN;
  const p = join(ROOT, ".data", "arena.token");
  if (!read(p)) writeSecret(p, randomBytes(16).toString("hex"));
  return read(p);
}
function sameToken(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function providerKey(provider) {
  if (provider === "ollama") return "ollama";
  return read(join(KEYS_DIR, `${provider}.key`)) || process.env[`${provider.toUpperCase()}_API_KEY`] || "";
}
export function saveProviderKey(provider, key) {
  if (!PROVIDERS[provider] || provider === "ollama") throw new Error(`unknown provider ${provider}`);
  writeSecret(join(KEYS_DIR, `${provider}.key`), String(key).trim());
}
export function keyStatus() {
  return Object.fromEntries(
    Object.keys(PROVIDERS)
      .filter((p) => p !== "ollama")
      .map((p) => {
        const k = providerKey(p);
        return [p, k ? { saved: true, hint: `…${k.slice(-4)}` } : { saved: false }];
      }),
  );
}

// Prices per model (design/model_prices.json), read when it changes.
let pricesCache = { mtime: 0, data: {} };
export function modelPrices() {
  const file = join(ROOT, "design", "model_prices.json");
  try {
    const mtime = statSync(file).mtimeMs;
    if (mtime !== pricesCache.mtime) pricesCache = { mtime, data: JSON.parse(readFileSync(file, "utf8")) };
  } catch {}
  return pricesCache.data;
}

function adaptBody(provider, model, body) {
  const b = { ...body, model };
  if (provider === "anthropic") {
    delete b.temperature;
    delete b.top_p;
  }
  if (provider === "openai" && OPENAI_REASONING.test(model)) {
    if (b.max_tokens !== undefined) {
      b.max_completion_tokens = Math.max(b.max_tokens, 2048);
      delete b.max_tokens;
    }
    delete b.temperature;
    delete b.top_p;
  }
  return b;
}

async function callChatCompletions(provider, model, body) {
  const base = provider === "ollama" ? OLLAMA_BASE : PROVIDERS[provider]?.base;
  if (!base) throw new Error(`unknown provider ${provider}`);
  const key = providerKey(provider);
  if (!key) throw new Error(`no ${PROVIDERS[provider].name} key saved`);
  return fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(provider === "openrouter" ? { "x-title": "Agentium Arena" } : {}) },
    body: JSON.stringify(adaptBody(provider, model, body)),
    signal: AbortSignal.timeout(180_000),
  });
}

// Per model: calls, errors, tokens, cost.
export const usage = {};

// One model call for a side ("provider:model"). Answers in the chat-completions format, with the
// call's tokens and its cost (design/model_prices.json) counted per model.
export async function arenaCall(spec, body, cacheKey) {
  const provider = spec.slice(0, spec.indexOf(":"));
  const model = spec.slice(spec.indexOf(":") + 1);
  const fail = (status, message) => ({ status, text: JSON.stringify({ error: { message } }), tokens: 0, usd: null, usage: null, reply: null });
  if (!PROVIDERS[provider] || !model) return fail(400, `model must be provider:model, got "${spec}"`);
  const u = (usage[spec] ??= { requests: 0, errors: 0, tokens: 0, cacheRead: 0, output: 0, usd: 0, lastError: null });
  u.requests++;
  const failed = (status, message) => {
    u.errors++;
    u.lastError = `${status}: ${String(message).slice(0, 300)}`;
    return fail(status, String(message).slice(0, 600));
  };
  let reply;
  try {
    if (provider === "anthropic") {
      const key = providerKey("anthropic");
      if (!key) return failed(401, "no Anthropic key saved");
      const send = (req) => fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify(req), signal: AbortSignal.timeout(180_000) });
      let req = toAnthropic(body, model);
      let up = await send(req);
      let raw = await up.text();
      // Claude checks thinking it is sent back against the conversation it was written in; if the
      // history changed on the way, send the turn again without the old thinking.
      if (up.status === 400 && /thinking/i.test(raw)) {
        req = withoutThinking(req);
        up = await send(req);
        raw = await up.text();
      }
      if (!up.ok) return failed(up.status, raw);
      reply = fromAnthropic(JSON.parse(raw));
    } else if (provider === "openai" && OPENAI_REASONING.test(model)) {
      const key = providerKey("openai");
      if (!key) return failed(401, "no OpenAI key saved");
      const up = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(toResponses(body, model, cacheKey)), signal: AbortSignal.timeout(180_000) });
      const raw = await up.text();
      if (!up.ok) return failed(up.status, raw);
      reply = fromResponses(JSON.parse(raw));
    } else {
      // Local models play without thinking: a thinking turn of a 4B model takes far too long.
      const local = provider === "ollama" ? { reasoning_effort: "none" } : {};
      const up = await callChatCompletions(provider, model, { ...body, model, max_tokens: Math.max(Number(body.max_tokens) || 0, WAR_MAX_TOKENS), ...local });
      const raw = await up.text();
      if (!up.ok) return failed(up.status, raw);
      reply = JSON.parse(raw);
    }
  } catch (e) {
    return failed(502, e instanceof Error ? e.message : e);
  }
  const tokens = (reply.usage?.prompt_tokens ?? 0) + (reply.usage?.completion_tokens ?? 0);
  const usd = callCost(modelPrices(), spec, reply.usage);
  u.tokens += tokens;
  u.cacheRead += reply.usage?.x_cache_read ?? 0;
  u.output += reply.usage?.completion_tokens ?? 0;
  if (usd !== null) u.usd += usd;
  if (reply.usage) reply.usage.x_usd = usd;
  return { status: 200, text: JSON.stringify(reply), tokens, usd, usage: reply.usage ?? null, reply };
}

// The models each provider offers, asked of the provider with the saved key (PROVIDERS lists are
// the fallback).
const modelLists = {};
export async function fetchModels(provider) {
  try {
    if (provider === "anthropic") {
      const key = providerKey("anthropic");
      if (!key) return;
      const r = await fetch("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(10_000) });
      if (r.ok) modelLists.anthropic = (await r.json()).data.map((m) => m.id);
    } else if (provider === "openai") {
      const key = providerKey("openai");
      if (!key) return;
      const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return;
      const ids = (await r.json()).data.map((m) => m.id).filter((id) => /^(gpt-4\.1|gpt-4o|gpt-[5-9]|o[3-9])/.test(id) && !/audio|realtime|transcribe|tts|image|search|embedding|codex|preview|-pro\b|\d{4}-\d\d-\d\d/.test(id));
      modelLists.openai = ids.sort((a, b) => (a.startsWith("o") - b.startsWith("o")) || b.localeCompare(a, undefined, { numeric: true }));
    } else if (provider === "openrouter") {
      const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15_000) });
      if (r.ok) modelLists.openrouter = (await r.json()).data.filter((m) => (m.supported_parameters ?? []).includes("tools")).map((m) => m.id).sort();
    } else if (provider === "ollama") {
      const r = await fetch(OLLAMA_BASE.replace(/\/v1$/, "") + "/api/tags", { signal: AbortSignal.timeout(5_000) });
      if (r.ok) modelLists.ollama = (await r.json()).models.map((m) => m.name.replace(/:latest$/, "")).filter((n) => !/embed|bge|nomic/.test(n));
    }
  } catch {}
}
export function models(provider) {
  return modelLists[provider] ?? PROVIDERS[provider]?.models ?? [];
}

// ---- HTTP ----

export function startGateway(port = GATEWAY_PORT, host = "127.0.0.1") {
  const token = arenaToken();
  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") return send(200, { ok: true, keys: keyStatus() });
    if (url.pathname === "/keys" && req.method === "GET") return send(200, keyStatus());
    if (url.pathname === "/usage") return send(200, usage);
    if (url.pathname === "/models") {
      const p = url.searchParams.get("provider") ?? "anthropic";
      if (url.searchParams.get("refresh")) await fetchModels(p);
      return send(200, { provider: p, models: models(p) });
    }
    const keyPath = /^\/keys\/([a-z]+)$/.exec(url.pathname);
    if (keyPath && req.method === "PUT") {
      if (!sameToken(req.headers["x-arena-token"] ?? "", token)) return send(401, { error: { message: "bad token" } });
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        saveProviderKey(keyPath[1], raw);
      } catch (e) {
        return send(400, { error: { message: String(e.message ?? e) } });
      }
      fetchModels(keyPath[1]);
      return send(200, { ok: true, keys: keyStatus() });
    }
    if (url.pathname === "/llm/arena/v1/chat/completions") {
      if (req.method !== "POST") return send(405, { error: { message: "POST only" } });
      if (!sameToken(req.headers["x-arena-token"] ?? "", token)) return send(401, { error: { message: "bad token" } });
      let body;
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        body = JSON.parse(raw || "{}");
      } catch {
        return send(400, { error: { message: "bad JSON" } });
      }
      const r = await arenaCall(String(body.model ?? ""), body, body.user);
      res.writeHead(r.status, { "content-type": "application/json" });
      return res.end(r.text);
    }
    return send(404, { error: { message: "not found" } });
  });
  server.listen(port, host, () => console.log(`[gateway] http://${host}:${port} (keys in ${KEYS_DIR})`));
  setTimeout(() => Promise.all(Object.keys(PROVIDERS).map(fetchModels)), 500);
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startGateway();
