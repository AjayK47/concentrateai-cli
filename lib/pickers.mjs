import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { CnError } from "./errors.mjs";

const CLAUDE_PREFERRED = ["claude-sonnet-4-6", "claude-opus-4-6", "deepseek-v4-1-flash"];

function claudeShortlist(selected, models, limit = 20) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const chosen = [];
  const seen = new Set();
  const take = (item) => {
    chosen.push(item);
    seen.add(item.id);
  };
  for (const id of [selected, ...CLAUDE_PREFERRED]) {
    if (byId.has(id) && !seen.has(id)) take(byId.get(id));
  }
  const family = (item) => item.id.split("-")[0];
  const families = new Set(chosen.map(family));
  for (const item of models) {
    if (!seen.has(item.id) && !families.has(family(item))) {
      take(item);
      families.add(family(item));
    }
    if (chosen.length >= limit) return chosen;
  }
  for (const item of models) {
    if (!seen.has(item.id)) take(item);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

// Claude also reads credentials from the user's own settings files (an apiKeyHelper,
// or an env block). Flag settings outrank those, so cn blanks every credential and
// routing switch there and supplies its key only through a helper that reads it
// from the child's environment. The key itself never appears in argv or on disk.
export const CLAUDE_KEY_VAR = "CN_CLAUDE_KEY";
export const CLAUDE_BLANKED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

export function claudeSettings(apiRoot, model, models) {
  return {
    apiKeyHelper: `printenv ${CLAUDE_KEY_VAR}`,
    env: {
      ...Object.fromEntries(CLAUDE_BLANKED.map((name) => [name, ""])),
      ANTHROPIC_BASE_URL: apiRoot,
      ANTHROPIC_MODEL: model,
    },
    modelPicker: {
      replaceBuiltInOptions: false,
      options: claudeShortlist(model, models).map((entry) => ({
        model: entry.id,
        label: entry.name,
        description: "Concentrate AI",
      })),
    },
  };
}

// v1-format config: v1 reads it natively and v2 accepts it, so one shape covers both.
export function opencodeConfig(apiRoot, model, models) {
  return {
    $schema: "https://opencode.ai/config.json",
    model: `concentrate/${model}`,
    provider: {
      concentrate: {
        npm: "@ai-sdk/openai-compatible",
        name: "Concentrate AI",
        options: { baseURL: `${apiRoot}/v1`, apiKey: "{env:CONCENTRATE_API_KEY}" },
        models: Object.fromEntries(models.map((entry) => [entry.id, { name: entry.name }])),
      },
    },
  };
}

export function piConfig(apiRoot, models) {
  const entries = models.map((entry) => {
    const data = { id: entry.id, name: entry.name };
    if (Number.isInteger(entry.context) && entry.context > 0) data.contextWindow = entry.context;
    if (Number.isInteger(entry.output) && entry.output > 0) data.maxTokens = entry.output;
    data.input = entry.image ? ["text", "image"] : ["text"];
    data.reasoning = Boolean(entry.reasoning);
    return data;
  });
  return {
    providers: {
      concentrate: {
        baseUrl: `${apiRoot}/v1`,
        api: "openai-completions",
        apiKey: "$CONCENTRATE_API_KEY",
        models: entries,
      },
    },
  };
}

export function writeCodexCatalog(executable, models, destination) {
  const entries = models.map((item, index) => ({
    slug: item.id,
    display_name: item.name,
    description: "Concentrate AI model",
    visibility: "list",
    supported_in_api: true,
    // Codex lists lower priority first, so this keeps cn's order in its picker.
    priority: index + 1,
    default_reasoning_level: "none",
    supported_reasoning_levels: [],
    shell_type: "shell_command",
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    experimental_supported_tools: [],
    base_instructions:
      "You are a coding assistant. Follow the user's instructions and use available tools when they help complete the task.",
    input_modalities: item.image ? ["text", "image"] : ["text"],
    context_window: Number.isInteger(item.context) && item.context > 0 ? item.context : 128000,
  }));
  fs.writeFileSync(destination, JSON.stringify({ models: entries }), { mode: 0o600 });
  // Validate against the exact installed Codex version before launching.
  const probe = spawnSync(
    executable,
    ["-c", `model_catalog_json=${JSON.stringify(destination)}`, "debug", "models"],
    { encoding: "utf8", timeout: 15000 },
  );
  if (probe.error || probe.status !== 0) {
    throw new CnError("This Codex version rejected the temporary model catalog");
  }
  return destination;
}
