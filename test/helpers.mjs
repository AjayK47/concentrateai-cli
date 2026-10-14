import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const BIN = fileURLToPath(new URL("../bin/cn.mjs", import.meta.url));

export function tempDir(prefix = "cn-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A stand-in tool that records argv and selected env vars, then exits with `exitCode`.
export function fakeTool(directory, name, { exitCode = 0 } = {}) {
  const record = path.join(directory, `${name}.record.json`);
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|CONCENTRATE_|PI_CODING|CN_CLAUDE)/.test(k))),
}));
process.exit(${exitCode});
`;
  const file = path.join(directory, name);
  fs.writeFileSync(file, script, { mode: 0o755 });
  return () => JSON.parse(fs.readFileSync(record, "utf8"));
}

export function runCn(args, { env = {}, input } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    input,
    env: { PATH: path.dirname(process.execPath), HOME: os.homedir(), CN_OFFLINE: "1", ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
