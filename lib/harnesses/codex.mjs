import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { API_ROOT } from "../catalog.mjs";
import { writeCodexCatalog } from "../pickers.mjs";
import { createdMs, filesIn, lastModelInTranscript, parseLine, regularFile } from "../recall.mjs";

// Codex files sessions by date. Check local and UTC days at both ends of the run.
function sessionDirs(env, startedAt) {
  const root = path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  const two = (n) => String(n).padStart(2, "0");
  const days = new Set();
  for (const time of [startedAt, Date.now()]) {
    const d = new Date(time);
    days.add(`${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`);
    days.add(`${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}`);
  }
  return [...days].map((day) => path.join(root, day));
}

// Codex has no session-ID flag, so a session counts only if it was created during
// this run, in this directory, on the Concentrate provider.
function isThisRun(file, { cwd, startedAt }) {
  if (!regularFile(file) || createdMs(file) < startedAt - 1000) return false;
  const header = parseLine(fs.readFileSync(file, "utf8").split("\n", 1)[0]);
  const meta = header?.type === "session_meta" ? header.payload : null;
  return Boolean(meta && meta.cwd === cwd && meta.model_provider === "concentrate");
}

function recallCodexModel({ env, cwd, startedAt }) {
  const files = sessionDirs(env, startedAt)
    .flatMap((dir) => filesIn(dir, ".jsonl"))
    .filter((file) => isThisRun(file, { cwd, startedAt }))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files.length
    ? lastModelInTranscript(files[0], (entry) => entry.type === "turn_context" && entry.payload?.model)
    : null;
}

export default {
  id: "codex",
  label: "Codex CLI",
  binary: "codex",
  installHint: "Install Codex CLI (npm install -g @openai/codex), then run cn codex again.",
  modelFlags: ["-m", "--model"],

  async prepare({ executable, model, key, available, forwarded, env }) {
    const startedAt = Date.now();
    const overrides = [
      'model_provider="concentrate"',
      'model_providers.concentrate.name="Concentrate AI"',
      `model_providers.concentrate.base_url="${API_ROOT}/v1"`,
      'model_providers.concentrate.env_key="CONCENTRATE_API_KEY"',
      'model_providers.concentrate.wire_api="responses"',
      "model_providers.concentrate.requires_openai_auth=false",
    ];
    let directory = null;
    if (available.length > 1) {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), "cn-codex-"));
      try {
        const catalog = writeCodexCatalog(executable, available, path.join(directory, "models.json"));
        overrides.push(`model_catalog_json=${JSON.stringify(catalog)}`);
      } catch {
        console.error("Codex rejected the temporary model catalog; using its normal picker.");
      }
    }
    return {
      args: [...overrides.flatMap((value) => ["-c", value]), "-m", model, ...forwarded],
      env: { CONCENTRATE_API_KEY: key },
      recall: () => recallCodexModel({ env, cwd: fs.realpathSync(process.cwd()), startedAt }),
      cleanup() {
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  },
};
