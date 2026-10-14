import path from "node:path";

import { CnError } from "./errors.mjs";
import { cleanText, isModelId } from "./safe.mjs";
import { configDir, readJson, writeJson } from "./settings.mjs";

export const API_ROOT = "https://api.concentrate.ai";
const VALIDATION_MODEL = "deepseek-v4-1-flash";
const CACHE_SECONDS = 3600;
const MAX_PAGES = 10;

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function requestJson(url, { headers = {}, body, timeoutMs = 20000 } = {}) {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}

export async function validateKey(key) {
  try {
    await requestJson(`${API_ROOT}/v1/chat/completions`, {
      headers: { Authorization: `Bearer ${key}` },
      body: { model: VALIDATION_MODEL, messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
    });
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      throw new CnError("Concentrate AI rejected this API key (HTTP 401)");
    }
    if (error instanceof HttpError) {
      throw new CnError(`Key check could not complete (HTTP ${error.status}). Try again or use --no-verify.`);
    }
    throw new CnError("Key check could not reach Concentrate AI. Try again or use --no-verify.");
  }
}

const tokens = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : null);

function model(fields) {
  const name = typeof fields.name === "string" ? cleanText(fields.name) : "";
  return {
    id: fields.id,
    name: name || fields.id,
    claude: fields.claude === true,
    codex: fields.codex === true,
    chat_candidate: fields.chat_candidate === true,
    context: tokens(fields.context),
    output: tokens(fields.output),
    image: fields.image === true,
    reasoning: fields.reasoning === true,
  };
}

// The catalog is remote input: entries with an unusable ID are dropped, names are made inert.
export function summarize(raw) {
  if (!raw || typeof raw !== "object" || !isModelId(raw.id)) return null;
  const integrations = raw.integrations ?? {};
  const providers = Object.values(raw.providers ?? {}).filter((p) => p && typeof p === "object");
  const capabilities = raw.capabilities ?? {};
  return model({
    id: raw.id,
    name: typeof raw.display_name === "string" && raw.display_name ? raw.display_name : raw.name,
    claude: integrations.claude_code?.supported === true,
    codex: integrations.codex?.supported === true,
    chat_candidate: providers.some(
      (p) => p.supports?.input?.text === true && p.supports?.tools?.function_calling === true,
    ),
    context: raw.max_input_tokens,
    output: raw.max_tokens,
    image: capabilities.image_input?.supported === true,
    reasoning: capabilities.thinking?.supported === true,
  });
}

// The cache is re-checked on read, so a hand-edited or old cache cannot crash cn.
function fromCache(entry) {
  return entry && typeof entry === "object" && isModelId(entry.id) ? model(entry) : null;
}

async function fetchAllPages() {
  const models = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    const result = await requestJson(`${API_ROOT}/v1/models${query}`);
    if (!Array.isArray(result.data)) throw new Error("invalid model catalog");
    models.push(...result.data);
    if (!result.has_more) return models;
    after = result.last_id;
    if (!after) throw new Error("model catalog pagination stopped without a cursor");
  }
  throw new Error("model catalog has more pages than expected");
}

export async function fetchCatalog({ refresh = false, env = process.env } = {}) {
  const file = path.join(configDir(env), "catalog.json");
  let cached = {};
  try {
    cached = readJson(file);
  } catch {
    cached = {};
  }
  const saved = Array.isArray(cached.models) ? cached.models.map(fromCache).filter(Boolean) : null;
  const fresh = saved && Date.now() / 1000 - (cached.fetchedAt ?? 0) < CACHE_SECONDS;
  if (!refresh && fresh) return { models: saved, source: "cache" };
  if (env.CN_OFFLINE === "1") {
    if (saved) return { models: saved, source: "offline cache" };
    throw new CnError("Model catalog is unavailable in offline mode");
  }
  try {
    const models = (await fetchAllPages())
      .map(summarize)
      .filter(Boolean)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    writeJson(file, { fetchedAt: Date.now() / 1000, models });
    return { models, source: "live" };
  } catch {
    if (saved) return { models: saved, source: "stale cache" };
    throw new CnError("Could not fetch the Concentrate AI model catalog");
  }
}

export function modelsFor(harness, models) {
  if (harness === "claude") return models.filter((m) => m.claude);
  if (harness === "codex") return models.filter((m) => m.codex);
  return models.filter((m) => m.chat_candidate);
}

export function ensureModel(models, selected) {
  if (models.some((m) => m.id === selected)) return models;
  return [...models, { id: selected, name: selected, context: null, output: null, image: false, reasoning: false }];
}

export async function probeHarness(harness, model, key) {
  let url;
  let headers;
  let body;
  if (harness === "claude") {
    url = `${API_ROOT}/v1/messages`;
    headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
    body = { model, max_tokens: 8, messages: [{ role: "user", content: "Reply OK." }] };
  } else if (harness === "codex") {
    url = `${API_ROOT}/v1/responses`;
    headers = { Authorization: `Bearer ${key}` };
    body = { model, input: "Reply OK.", max_output_tokens: 8 };
  } else {
    url = `${API_ROOT}/v1/chat/completions`;
    headers = { Authorization: `Bearer ${key}` };
    body = { model, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 8 };
  }
  try {
    await requestJson(url, { headers, body, timeoutMs: 30000 });
  } catch (error) {
    if (error instanceof HttpError) {
      throw new CnError(`${harness} route returned HTTP ${error.status} for model ${model}`);
    }
    throw new CnError(`${harness} route did not complete for model ${model}`);
  }
}
