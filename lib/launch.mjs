import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { ensureModel, fetchCatalog, modelsFor } from "./catalog.mjs";
import { CnError, EXIT } from "./errors.mjs";
import { getHarness } from "./harnesses/registry.mjs";
import { readPreferences, resolveKey, writePreferences } from "./settings.mjs";
import { ledger } from "./ui/layout.mjs";

export function which(command, searchPath = process.env.PATH ?? "") {
  for (const directory of searchPath.split(path.delimiter).filter((entry) => path.isAbsolute(entry))) {
    const candidate = path.join(directory, command);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // not here; keep looking
    }
  }
  return null;
}

function missingToolError(adapter) {
  return new CnError(
    `${adapter.label} isn't installed (\`${adapter.binary}\` was not found on your PATH).\n${adapter.installHint}`,
    EXIT.NOT_FOUND,
  );
}

function run(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", env });
    // Ctrl-C reaches the whole foreground group; the tool decides how to handle it.
    const onInterrupt = () => {};
    const forward = (signal) => () => child.kill(signal);
    const handlers = { SIGTERM: forward("SIGTERM"), SIGHUP: forward("SIGHUP") };
    process.on("SIGINT", onInterrupt);
    for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
    const detach = () => {
      process.off("SIGINT", onInterrupt);
      for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler);
    };
    child.on("error", (error) => {
      detach();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      detach();
      resolve(code ?? 128 + (os.constants.signals[signal] ?? 0));
    });
  });
}

// A model given to the tool directly is a one-off choice, not a new default.
function passesModelFlag(forwarded, flags = []) {
  return forwarded.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}

// If the user switched models inside the tool, start there next time. Only a
// model that differs from the launch model and exists in the catalog counts.
function rememberModel({ prepared, adapter, launched, available, env }) {
  const used = prepared.recall?.();
  if (typeof used !== "string") return;
  const known = new Set(available.map((m) => m.id));
  const id = [used, used.split("/").pop()].find((candidate) => known.has(candidate));
  if (!id || id === launched) return;
  const preferences = readPreferences(env);
  preferences[adapter.id] = id;
  writePreferences(preferences, env);
  // stderr, so a tool's output piped to a file stays clean.
  console.error(ledger("ok", "remembered", `${adapter.label} will start on ${id} next time`));
}

export async function launch(
  harnessId,
  { model: override, forwarded = [], tty = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {},
  env = process.env,
) {
  const adapter = getHarness(harnessId);

  // Cheapest checks first: a missing tool should never cost a network call.
  const executable = which(adapter.binary, env.PATH);
  if (!executable) throw missingToolError(adapter);

  const { key } = resolveKey(env);
  if (!key) throw new CnError("No API key found. Run cn setup first.");

  const model = override || readPreferences(env)[harnessId];
  let available;
  let catalogLoaded = false;
  try {
    const { models } = await fetchCatalog({ env });
    available = ensureModel(modelsFor(harnessId, models), model);
    catalogLoaded = true;
  } catch {
    console.error("Model catalog unavailable; starting with the selected model only.");
    available = ensureModel([], model);
  }

  const prepared = await adapter.prepare({ executable, model, key, available, forwarded, env });
  const childEnv = { ...env, ...prepared.env };
  for (const name of prepared.unset ?? []) delete childEnv[name];

  let code;
  try {
    code = await run(executable, prepared.args, childEnv);
  } catch (error) {
    prepared.cleanup();
    if (error.code === "ENOENT") throw missingToolError(adapter);
    // Only the error code: spawn messages can quote environment values, including the key.
    throw new CnError(`Could not start ${adapter.label} (${error.code ?? "unknown error"}).`);
  }

  // Remembering is best effort and must never change the tool's exit code. Model
  // switches only happen in interactive sessions, so scripted runs are left alone.
  try {
    if (catalogLoaded && tty && !passesModelFlag(forwarded, adapter.modelFlags)) {
      rememberModel({ prepared, adapter, launched: model, available, env });
    }
  } catch (error) {
    console.error(ledger("warn", "remember", `skipped: ${error instanceof CnError ? error.message : "could not read the session"}`));
  } finally {
    prepared.cleanup();
  }
  return code;
}
