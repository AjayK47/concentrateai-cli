import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { API_ROOT } from "../catalog.mjs";
import { CLAUDE_BLANKED, CLAUDE_KEY_VAR, claudeSettings } from "../pickers.mjs";
import { filesIn, lastModelInTranscript, regularFile } from "../recall.mjs";

const RESUMES = ["-c", "--continue", "-r", "--resume", "--session-id", "--fork-session"];

const resumes = (forwarded) =>
  forwarded.some((arg) => RESUMES.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));

// Claude names each transcript after its session ID, under a per-directory folder.
function recallClaudeModel({ env, sessionId }) {
  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  const file = filesIn(projects, "")
    .map((dir) => path.join(dir, `${sessionId}.jsonl`))
    .find(regularFile);
  return file ? lastModelInTranscript(file, (entry) => entry.type === "assistant" && entry.message?.model) : null;
}

export default {
  id: "claude",
  label: "Claude Code",
  binary: "claude",
  installHint: "Install Claude Code (https://claude.com/claude-code), then run cn claude again.",
  modelFlags: ["--model"],

  async prepare({ model, key, available, forwarded, env }) {
    // Pinning the session ID tells cn exactly which transcript is this run's.
    // A resumed session already has an ID, so nothing is remembered for it.
    const sessionId = resumes(forwarded) ? null : randomUUID();
    // The key travels in the child's environment only, under a name only cn's helper reads.
    const settings = JSON.stringify(claudeSettings(API_ROOT, model, available));
    return {
      args: ["--settings", settings, "--model", model, ...(sessionId ? ["--session-id", sessionId] : []), ...forwarded],
      env: { ANTHROPIC_BASE_URL: API_ROOT, ANTHROPIC_MODEL: model, [CLAUDE_KEY_VAR]: key },
      // Also dropped from the inherited environment, so nothing the shell exports
      // reaches Concentrate or routes around it.
      unset: CLAUDE_BLANKED,
      recall: () => (sessionId ? recallClaudeModel({ env, sessionId }) : null),
      cleanup() {},
    };
  },
};
