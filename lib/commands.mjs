import {
  ensureModel,
  fetchCatalog,
  modelsFor,
  probeHarness,
  validateKey,
} from "./catalog.mjs";
import { CnError } from "./errors.mjs";
import { isApiKey } from "./safe.mjs";
import { getHarness, listHarnesses } from "./harnesses/registry.mjs";
import { which } from "./launch.mjs";
import { ask, askHidden } from "./prompt.mjs";
import {
  configDir,
  deleteStoredKey,
  HARNESS_IDS,
  readPreferences,
  environmentKey,
  readStoredKey,
  resetState,
  resetTargets,
  resolveKey,
  writeKey,
  writePreferences,
} from "./settings.mjs";
import { focusIn, header } from "./ui/brand.mjs";
import { ledger, panel } from "./ui/layout.mjs";
import { modelItem, modelLegend, modelRight } from "./ui/models.mjs";
import { caps, pad, paint } from "./ui/term.mjs";
import { glyphs } from "./ui/theme.mjs";
import { interactive, password, select, spinner } from "./ui/widgets.mjs";
import { version } from "./version.mjs";

const SUGGESTED_MODELS = ["claude-sonnet-4-6", "deepseek-v4-1-flash"];

// ---- helpers shared by commands -------------------------------------------------

// Runs `work` under a spinner and prints one ledger line when it succeeds.
async function step(running, label, work, done) {
  const spin = spinner(running);
  try {
    const result = await work();
    spin.succeed(ledger("ok", label, typeof done === "function" ? done(result) : done));
    return result;
  } catch (error) {
    spin.stop();
    throw error;
  }
}

function matches(models, query) {
  const needle = query.toLowerCase();
  return models.filter((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
}

// Plain numbered prompt: used when stdin or stdout is not a terminal.
async function promptModelPlain(harnessId, current, catalog) {
  const available = modelsFor(harnessId, catalog);
  const byId = new Map(available.map((m) => [m.id, m]));
  const suggestions = [current, ...SUGGESTED_MODELS.filter((id) => id !== current && byId.has(id))];
  console.log(`\n${getHarness(harnessId).label} default model`);
  suggestions.forEach((id, index) => console.log(`  ${index + 1}) ${id}${index === 0 ? " (current)" : ""}`));
  console.log("Type a model ID or ?search to browse the catalog.");
  for (;;) {
    const answer = await ask(`Select [Enter keeps ${current}]: `);
    if (!answer) return current;
    if (/^\d+$/.test(answer)) {
      const picked = suggestions[Number(answer) - 1];
      if (picked) return picked;
      console.log("Enter a listed number, model ID, or ?search.");
      continue;
    }
    if (answer.startsWith("?")) {
      const found = matches(available, answer.slice(1).trim());
      for (const item of found.slice(0, 20)) console.log(`  ${item.id} - ${item.name}`);
      console.log(`${found.length} matches${found.length > 20 ? " (showing 20)" : ""}`);
      continue;
    }
    if (available.length && !byId.has(answer)) {
      console.log("That ID is not in this tool's catalog; it may still work.");
    }
    return answer;
  }
}

async function chooseModel(harnessId, current, catalog) {
  if (!interactive()) return promptModelPlain(harnessId, current, catalog);
  const c = caps();
  const available = ensureModel(modelsFor(harnessId, catalog), current);
  const result = await select({
    title: `${getHarness(harnessId).label}  ${paint("mute", "default model", {}, c)}`,
    items: available.map((model) => modelItem(model, c)),
    initial: current,
    filterable: true,
    allowCustom: true,
    rows: 9,
    legend: modelLegend(c),
    hints: [["↑↓", "move"], ["↵", "choose"], ["type", "filter"], ["esc", `keep ${current}`]],
  });
  return result.cancel ? current : result.value;
}

async function promptKey(existing, inherited) {
  const fallback = existing || inherited;
  const placeholder = existing ? "Enter keeps the saved key" : inherited ? "Enter saves CONCENTRATE_API_KEY" : "paste your key";
  const entered = interactive()
    ? await password({ label: "API key", placeholder })
    : await askHidden("Concentrate AI key (hidden): ");
  const key = entered || fallback;
  if (!key) throw new CnError("API key is required");
  if (!isApiKey(key)) throw new CnError("That doesn't look like an API key: it has spaces or control characters.");
  return key;
}

export function maskKey(key) {
  const tail = key.length >= 12 ? key.slice(-4) : "";
  return "•".repeat(8) + tail;
}

// Offers a key that is already around instead of asking for it again. A key
// found only in the environment is used in place and not copied to disk.
async function chooseKey(env) {
  const stored = readStoredKey(env);
  const fromEnv = environmentKey(env);
  const found = stored || fromEnv;
  if (interactive(env) && found) {
    const c = caps();
    const choice = await select({
      title: `Found a Concentrate AI key ${paint("mute", stored ? "saved by cn" : "in your environment", {}, c)}`,
      items: [
        { value: "use", label: "Use this key", note: maskKey(found), tone: "focus" },
        { value: "new", label: "Paste a different key" },
      ],
      hints: [["↑↓", "move"], ["↵", "choose"], ["esc", "cancel"]],
    });
    if (choice.cancel) throw new CnError("Cancelled", 130);
    if (choice.value === "use") return { key: found, persist: Boolean(stored) };
    return { key: await promptKey(null, null), persist: true };
  }
  const key = await promptKey(stored, fromEnv);
  return { key, persist: key !== fromEnv || Boolean(stored) };
}

// ---- commands ---------------------------------------------------------------------

export async function runSetup({ verify = true, showHeader = true, models: customize = false } = {}, env = process.env) {
  const c = caps();
  if (showHeader && interactive(env)) {
    await focusIn(c);
    console.log(header(version(), {}, c).join("\n") + "\n");
  } else if (showHeader) {
    console.log("Concentrate AI setup\n");
  }
  const { key, persist } = await chooseKey(env);
  if (verify) {
    await step("checking the key", "key", () => validateKey(key), "verified");
  } else {
    console.log(ledger("warn", "key", "saved without a live check", c));
  }
  const models = readPreferences(env);
  if (customize) {
    let catalog = [];
    try {
      const result = await step("fetching the catalog", "catalog", () => fetchCatalog({ env }),
        (r) => `${r.models.length} models ${paint("mute", `(${r.source})`, {}, c)}`);
      catalog = result.models;
    } catch {
      console.log(ledger("warn", "catalog", "unavailable; you can still type model IDs", c));
    }
    for (const id of HARNESS_IDS) {
      models[id] = await chooseModel(id, models[id], catalog);
      console.log(ledger("ok", getHarness(id).label, models[id], c));
    }
    writePreferences(models, env);
  }
  if (persist) writeKey(key, env);
  const g = glyphs(c);
  console.log();
  for (const line of panel("ready", [
    ...HARNESS_IDS.map((id) => `${paint("focus", g.info, {}, c)} ${pad(`cn ${id}`, 9)} ${paint("mute", models[id], {}, c)}`),
    "",
    paint("mute", "change a default: cn model <tool>", {}, c),
  ], c)) console.log(line);
  return 0;
}

export async function runKey({ verify = true } = {}, env = process.env) {
  const key = await promptKey(readStoredKey(env), environmentKey(env));
  if (verify) await step("checking the key", "key", () => validateKey(key), "verified");
  writeKey(key, env);
  console.log(ledger(verify ? "ok" : "warn", "saved", verify ? "key stored" : "key stored without a live check"));
  return 0;
}

export function runLogout(env = process.env) {
  console.log(deleteStoredKey(env) ? ledger("ok", "logout", "saved key removed") : ledger("mute", "logout", "no saved key found"));
  if (env.CONCENTRATE_API_KEY) {
    console.log(ledger("warn", "environment", "CONCENTRATE_API_KEY is still set and can still be used"));
  }
  return 0;
}

export async function runReset({ yes = false, sessions = false } = {}, env = process.env) {
  const c = caps();
  const targets = resetTargets(env, { sessions });
  if (!targets.length) {
    console.log(ledger("mute", "reset", "nothing saved, already fresh", c));
    return 0;
  }
  if (!yes) {
    if (!interactive(env)) throw new CnError("Reset removes your saved key and models. Pass --yes to confirm.", 2);
    const names = targets.map((target) => target.split("/").pop()).join(", ");
    const choice = await select({
      title: `Reset cn?  ${paint("mute", names, {}, c)}`,
      items: [
        { value: "no", label: "Keep everything" },
        { value: "yes", label: "Reset", note: "removes the saved key, models, and catalog cache", tone: "bad" },
      ],
      hints: [["↑↓", "move"], ["↵", "choose"], ["esc", "cancel"]],
    });
    if (choice.cancel || choice.value !== "yes") {
      console.log(ledger("mute", "reset", "cancelled, nothing changed", c));
      return 0;
    }
  }
  for (const target of resetState(env, { sessions })) {
    console.log(ledger("ok", "removed", target.split("/").pop(), c));
  }
  if (!sessions) console.log(ledger("mute", "kept", "Pi sessions (use --sessions to remove them too)", c));
  if (env.CONCENTRATE_API_KEY) {
    console.log(ledger("warn", "environment", "CONCENTRATE_API_KEY is still set in your shell", c));
  }
  console.log(`\n  ${paint("mute", "Run cn to set up again.", {}, c)}`);
  return 0;
}

export function showConfig(env = process.env) {
  const { key, source } = resolveKey(env);
  console.log(ledger("mute", "config", configDir(env)));
  console.log(ledger(key ? "ok" : "bad", "api key", source));
  for (const [id, model] of Object.entries(readPreferences(env))) {
    console.log(ledger("info", getHarness(id).label, model));
  }
  return 0;
}

export async function runModel({ target, modelId }, env = process.env) {
  if (!target) return showConfig(env);
  const models = readPreferences(env);
  if (modelId) {
    models[target] = modelId;
  } else {
    let catalog = [];
    try {
      catalog = (await fetchCatalog({ env })).models;
    } catch {
      // continue with an empty catalog; the user can still type an ID
    }
    models[target] = await chooseModel(target, models[target], catalog);
  }
  writePreferences(models, env);
  console.log(ledger("ok", getHarness(target).label, `default model ${models[target]}`));
  return 0;
}

export async function showModels({ target, search, refresh, limit }, env = process.env) {
  const { models, source } = await fetchCatalog({ refresh, env });
  let candidates = target ? modelsFor(target, models) : models;
  if (search) candidates = matches(candidates, search);
  const c = caps();
  console.log(`${candidates.length} models (${source})`);
  const width = Math.max(0, ...candidates.slice(0, limit).map((m) => m.id.length));
  for (const item of candidates.slice(0, limit)) {
    console.log(process.stdout.isTTY
      ? `${item.id.padEnd(width)}  ${modelRight(item, c)}  ${paint("mute", item.name, {}, c)}`
      : `${item.id}  ${item.name}`);
  }
  if (candidates.length > limit) console.log(`Showing ${limit}. Use --search or --limit to narrow the list.`);
  return 0;
}

// Read-only catalog browser used by the launcher.
export async function browseModels(env = process.env) {
  const c = caps();
  const { models } = await step("fetching the catalog", "catalog", () => fetchCatalog({ env }),
    (r) => `${r.models.length} models`);
  await select({
    title: `Catalog  ${paint("mute", "all models", {}, c)}`,
    items: models.map((model) => modelItem(model, c)),
    filterable: true,
    rows: 10,
    legend: modelLegend(c),
    hints: [["↑↓", "move"], ["type", "filter"], ["esc", "back"]],
  });
}

function withVersion(executable, adapter, c) {
  const found = adapter.version?.(executable);
  return found ? `${executable}  ${paint("mute", found, {}, c)}` : executable;
}

export async function runDoctor({ target } = {}, env = process.env) {
  const { key, source } = resolveKey(env);
  const c = caps();
  console.log(ledger(key ? "ok" : "bad", "api key", source, c));
  if (!target) {
    for (const adapter of listHarnesses()) {
      const found = which(adapter.binary, env.PATH);
      console.log(found
        ? ledger("ok", adapter.label, withVersion(found, adapter, c), c)
        : `${ledger("bad", adapter.label, "not installed", c)}\n    ${paint("mute", adapter.installHint, {}, c)}`);
    }
    console.log(`\n  ${paint("mute", "Run cn doctor <tool> for a live route check.", {}, c)}`);
    return key ? 0 : 1;
  }
  const adapter = getHarness(target);
  const executable = which(adapter.binary, env.PATH);
  if (!executable) {
    console.log(`${ledger("bad", adapter.label, "not installed", c)}\n    ${paint("mute", adapter.installHint, {}, c)}`);
    return 1;
  }
  console.log(ledger("ok", adapter.label, withVersion(executable, adapter, c), c));
  if (!key) return 1;
  await step("checking the key", "key", () => validateKey(key), "valid");
  const model = readPreferences(env)[target];
  try {
    const { models, source: from } = await fetchCatalog({ env });
    const eligible = modelsFor(target, models);
    console.log(ledger(eligible.some((m) => m.id === model) ? "ok" : "warn", "catalog",
      `${eligible.length} eligible models ${paint("mute", `(${from})`, {}, c)}`, c));
  } catch {
    console.log(ledger("warn", "catalog", "unavailable", c));
  }
  await step(`probing ${model}`, "route", () => probeHarness(target, model, key), `OK ${paint("mute", `(${model})`, {}, c)}`);
  return 0;
}
