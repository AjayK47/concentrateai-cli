import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { API_ROOT } from "../catalog.mjs";
import { piConfig } from "../pickers.mjs";
import { filesIn, lastModelInTranscript, regularFile } from "../recall.mjs";
import { configDir } from "../settings.mjs";

const RESOURCE_DIRS = ["extensions", "skills", "prompt-templates", "prompt_templates", "themes", "packages"];

function readObject(file) {
  try {
    if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) return {};
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writePrivate(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}

// Builds a private agent dir that keeps the user's Pi settings, models, and
// resource dirs. Pi's auth.json is deliberately not copied.
function preparePiDir(directory, model, available, env) {
  const source = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  writePrivate(path.join(directory, "settings.json"), {
    ...readObject(path.join(source, "settings.json")),
    defaultProvider: "concentrate",
    defaultModel: model,
  });
  const existing = readObject(path.join(source, "models.json")).providers;
  writePrivate(path.join(directory, "models.json"), {
    providers: {
      ...(existing && typeof existing === "object" ? existing : {}),
      ...piConfig(API_ROOT, available).providers,
    },
  });
  for (const name of RESOURCE_DIRS) {
    const original = path.join(source, name);
    if (fs.existsSync(original) && fs.statSync(original).isDirectory()) {
      fs.symlinkSync(original, path.join(directory, name), "dir");
    }
  }
}

const RESUMES = ["-c", "--continue", "-r", "--resume", "--session", "--session-id", "--fork", "--no-session"];

const has = (forwarded, flags) =>
  forwarded.some((arg) => flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));

function optionValue(forwarded, flag) {
  const at = forwarded.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (at < 0) return null;
  return forwarded[at] === flag ? forwarded[at + 1] ?? null : forwarded[at].slice(flag.length + 1);
}

// Pi names a transcript "<time>_<session id>.jsonl" and records each model switch in it.
function recallPiModel({ sessionDir, sessionId }) {
  const file = filesIn(sessionDir, `_${sessionId}.jsonl`).find(regularFile);
  return file ? lastModelInTranscript(file, (entry) => {
    if (entry.type === "model_change" && entry.provider === "concentrate") return entry.modelId;
    const reply = entry.message;
    if (entry.type === "message" && reply?.role === "assistant" && reply.provider === "concentrate") return reply.model;
    return null;
  }) : null;
}

export default {
  id: "pi",
  label: "Pi",
  binary: "pi",
  installHint: "Install Pi and make sure `pi` is on your PATH, then run cn pi again.",
  modelFlags: ["--model", "--provider"],

  async prepare({ model, key, available, forwarded, env }) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cn-pi-"));
    const cleanup = () => fs.rmSync(directory, { recursive: true, force: true });
    try {
      preparePiDir(directory, model, available, env);
      const args = ["--provider", "concentrate", "--model", model];
      let sessionDir = optionValue(forwarded, "--session-dir");
      if (!sessionDir && !has(forwarded, ["--no-session"])) {
        sessionDir = path.join(configDir(env), "pi-sessions");
        fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
        args.push("--session-dir", sessionDir);
      }
      // A pinned ID names this run's transcript. Resumed sessions keep their own.
      const sessionId = sessionDir && !has(forwarded, RESUMES) ? randomUUID() : null;
      if (sessionId) args.push("--session-id", sessionId);
      return {
        args: [...args, ...forwarded],
        env: { CONCENTRATE_API_KEY: key, PI_CODING_AGENT_DIR: directory },
        recall: () => (sessionId ? recallPiModel({ sessionDir, sessionId }) : null),
        cleanup,
      };
    } catch (error) {
      cleanup();
      throw error;
    }
  },
};
