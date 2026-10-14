import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { parseFlags, parseLaunchArgs } from "../lib/cli.mjs";
import { fakeTool, runCn, tempDir } from "./helpers.mjs";

function setup(extraEnv = {}) {
  const bin = tempDir("cn-bin-");
  const config = tempDir("cn-cfg-");
  const nodeDir = path.dirname(process.execPath);
  return {
    bin,
    config,
    env: { PATH: `${bin}:${nodeDir}`, CN_CONFIG_HOME: config, CONCENTRATE_API_KEY: "sk-test", ...extraEnv },
  };
}

test("a missing tool fails fast with exit 127, an install hint, and no key or network needed", () => {
  const { env } = setup({ CONCENTRATE_API_KEY: "" });
  const result = runCn(["codex"], { env });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Codex CLI isn't installed/);
  assert.match(result.stderr, /npm install -g @openai\/codex/);
  assert.doesNotMatch(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /API key/);
});

test("an installed tool with no key tells the user to run setup", () => {
  const { bin, env } = setup({ CONCENTRATE_API_KEY: "" });
  fakeTool(bin, "claude");
  const result = runCn(["claude"], { env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run cn setup first/);
});

test("claude gets Concentrate in its child environment and forwards args after --", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "claude");
  const result = runCn(["claude", "--model", "claude-opus-4-6", "--", "-p", "hello"], { env });
  assert.equal(result.status, 0, result.stderr);
  const seen = record();
  assert.equal(seen.env.ANTHROPIC_BASE_URL, "https://api.concentrate.ai");
  assert.equal(seen.env.CN_CLAUDE_KEY, "sk-test");
  assert.equal(seen.env.ANTHROPIC_API_KEY, undefined, "the key reaches Claude only through cn's helper");
  assert.equal(seen.env.ANTHROPIC_MODEL, "claude-opus-4-6");
  assert.deepEqual(seen.args.slice(0, 1), ["--settings"]);
  assert.equal(seen.args[seen.args.indexOf("--model") + 1], "claude-opus-4-6");
  assert.deepEqual(seen.args.slice(-2), ["-p", "hello"]);
  const settings = JSON.parse(seen.args[1]);
  assert.equal(settings.env.ANTHROPIC_MODEL, "claude-opus-4-6");
  assert.equal(settings.apiKeyHelper, "printenv CN_CLAUDE_KEY");
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"]) {
    assert.equal(settings.env[name], "", `${name} is blanked over the user's own settings files`);
  }
  assert.ok(!seen.args.join(" ").includes("sk-test"), "key must never appear in argv");
});

test("codex gets per-run provider overrides and the key only in env", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "codex");
  const result = runCn(["codex", "--", "exec", "hi"], { env });
  assert.equal(result.status, 0, result.stderr);
  const seen = record();
  assert.equal(seen.env.CONCENTRATE_API_KEY, "sk-test");
  const joined = seen.args.join("\n");
  assert.match(joined, /model_provider="concentrate"/);
  assert.match(joined, /model_providers\.concentrate\.base_url="https:\/\/api\.concentrate\.ai\/v1"/);
  assert.match(joined, /model_providers\.concentrate\.env_key="CONCENTRATE_API_KEY"/);
  assert.ok(!joined.includes("sk-test"));
  assert.equal(seen.args[seen.args.indexOf("-m") + 1], "deepseek-v4-1-flash");
  assert.deepEqual(seen.args.slice(-2), ["exec", "hi"]);
});

test("pi runs against a temporary agent dir that is removed afterwards", () => {
  const { bin, env } = setup();
  const record = fakeTool(bin, "pi");
  const result = runCn(["pi", "--", "-p", "hi"], { env });
  assert.equal(result.status, 0, result.stderr);
  const seen = record();
  assert.deepEqual(seen.args.slice(0, 4), ["--provider", "concentrate", "--model", "deepseek-v4-1-flash"]);
  assert.ok(seen.args.includes("--session-dir"));
  assert.match(seen.env.PI_CODING_AGENT_DIR, /cn-pi-/);
  assert.equal(fs.existsSync(seen.env.PI_CODING_AGENT_DIR), false, "temp dir should be cleaned up");
  assert.deepEqual(seen.args.slice(-2), ["-p", "hi"]);
});

test("pi keeps the user's settings and never copies auth.json", () => {
  const { bin, env } = setup();
  const source = tempDir("cn-pi-src-");
  fs.writeFileSync(path.join(source, "settings.json"), '{"theme":"dark"}');
  fs.writeFileSync(path.join(source, "auth.json"), '{"secret":"nope"}');
  const probe = path.join(bin, "pi");
  fs.writeFileSync(
    probe,
    `#!/usr/bin/env node
const fs = require("node:fs"), p = require("node:path");
const d = process.env.PI_CODING_AGENT_DIR;
console.log(JSON.stringify({ settings: JSON.parse(fs.readFileSync(p.join(d, "settings.json"), "utf8")), hasAuth: fs.existsSync(p.join(d, "auth.json")) }));
`,
    { mode: 0o755 },
  );
  const result = runCn(["pi"], { env: { ...env, PI_CODING_AGENT_DIR: source } });
  const out = JSON.parse(result.stdout);
  assert.equal(out.settings.theme, "dark");
  assert.equal(out.settings.defaultProvider, "concentrate");
  assert.equal(out.hasAuth, false);
});

test("the tool's exit code is propagated", () => {
  const { bin, env } = setup();
  fakeTool(bin, "claude", { exitCode: 7 });
  assert.equal(runCn(["claude"], { env }).status, 7);
});

test("argument parsing", () => {
  assert.deepEqual(parseLaunchArgs([]), { model: undefined, forwarded: [] });
  assert.deepEqual(parseLaunchArgs(["--model", "m", "--", "-p", "x"]), { model: "m", forwarded: ["-p", "x"] });
  assert.deepEqual(parseLaunchArgs(["--model=m"]), { model: "m", forwarded: [] });
  assert.deepEqual(parseLaunchArgs(["-p", "x"]), { model: undefined, forwarded: ["-p", "x"] });
  assert.throws(() => parseLaunchArgs(["--model"]), /needs a model ID/);
  assert.throws(() => parseFlags(["--nope"]), /Unknown option/);
  assert.deepEqual(parseFlags(["claude", "--search", "x"], { values: ["search"] }), {
    flags: { search: "x" },
    positionals: ["claude"],
  });
});

test("unknown commands and tools exit 2", () => {
  const { env } = setup();
  assert.equal(runCn(["bogus"], { env }).status, 2);
  assert.equal(runCn(["model", "nope"], { env }).status, 2);
  assert.equal(runCn(["models", "--limit", "0"], { env }).status, 2);
});

test("setup asks only for the key; config, model, and logout work end to end", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "" });
  const setupResult = runCn(["setup", "--no-verify"], { env, input: "sk-piped\n" });
  assert.equal(setupResult.status, 0, setupResult.stderr);
  assert.match(setupResult.stdout, /ready/);
  assert.match(setupResult.stdout, /cn claude\s+claude-sonnet-4-6/);
  assert.doesNotMatch(setupResult.stdout, /default model/, "no per-tool model questions");
  assert.equal(JSON.parse(fs.readFileSync(path.join(config, "credentials.json"), "utf8")).api_key, "sk-piped");
  assert.equal(fs.existsSync(path.join(config, "config.json")), false, "defaults need no config file");

  const modelResult = runCn(["model", "claude", "claude-opus-4-6"], { env });
  assert.match(modelResult.stdout, /Claude Code\s+default model claude-opus-4-6/);
  const configResult = runCn(["config"], { env });
  assert.match(configResult.stdout, /api key\s+stored/);
  assert.match(configResult.stdout, /Claude Code\s+claude-opus-4-6/);
  assert.doesNotMatch(configResult.stdout, /sk-piped/);

  assert.match(runCn(["logout"], { env }).stdout, /saved key removed/);
  assert.match(runCn(["config"], { env }).stdout, /api key\s+missing/);
});

test("setup --models also asks for each tool's default", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "" });
  const result = runCn(["setup", "--no-verify", "--models"], { env, input: "sk-piped\n\n\n\n\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Claude Code default model/);
  assert.equal(fs.existsSync(path.join(config, "config.json")), true);
});

test("reset needs --yes when not interactive, keeps Pi sessions, and can remove them", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "" });
  runCn(["setup", "--no-verify"], { env, input: "sk-piped\n\n\n\n" });
  fs.mkdirSync(path.join(config, "pi-sessions"));
  fs.writeFileSync(path.join(config, "pi-sessions", "s.jsonl"), "{}");

  const refused = runCn(["reset"], { env });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /--yes/);
  assert.ok(fs.existsSync(path.join(config, "credentials.json")), "nothing removed without confirmation");

  const done = runCn(["reset", "--yes"], { env });
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /removed\s+credentials\.json/);
  assert.match(done.stdout, /Pi sessions/);
  for (const name of ["credentials.json", "config.json", "catalog.json"]) {
    assert.equal(fs.existsSync(path.join(config, name)), false, name);
  }
  assert.ok(fs.existsSync(path.join(config, "pi-sessions", "s.jsonl")), "sessions are kept by default");

  assert.equal(runCn(["reset", "--yes", "--sessions"], { env }).status, 0);
  assert.equal(fs.existsSync(config), false, "empty config dir is removed");
  assert.match(runCn(["reset"], { env }).stdout, /already fresh/);
});

test("reset leaves an environment key alone and says so", () => {
  const { config, env } = setup({ CONCENTRATE_API_KEY: "sk-env" });
  runCn(["model", "claude", "claude-opus-4-6"], { env });
  const result = runCn(["reset", "--yes"], { env });
  assert.match(result.stdout, /CONCENTRATE_API_KEY is still set/);
  assert.equal(fs.existsSync(path.join(config, "config.json")), false);
});

test("claude never receives the user's own Anthropic credentials or a bypass flag", () => {
  const { bin, env } = setup();
  const record = path.join(bin, "env.json");
  fs.writeFileSync(path.join(bin, "claude"), `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.env));`, { mode: 0o755 });
  const leaky = {
    ANTHROPIC_API_KEY: "some-other-provider-key",
    ANTHROPIC_AUTH_TOKEN: "users-own-token",
    ANTHROPIC_CUSTOM_HEADERS: "X-Secret: 1",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
  };
  assert.equal(runCn(["claude"], { env: { ...env, ...leaky } }).status, 0);
  const seen = JSON.parse(fs.readFileSync(record, "utf8"));
  for (const name of Object.keys(leaky)) assert.equal(seen[name], undefined, name);
  assert.equal(seen.ANTHROPIC_API_KEY, undefined);
  assert.equal(seen.CN_CLAUDE_KEY, "sk-test");
  assert.equal(seen.ANTHROPIC_BASE_URL, "https://api.concentrate.ai");
});

test("a relative PATH entry never resolves a tool from the current directory", async () => {
  const { which } = await import("../lib/launch.mjs");
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    assert.equal(which("claude", "."), null);
    assert.equal(which("claude", dir), path.join(dir, "claude"));
  } finally {
    process.chdir(cwd);
  }
});

test("a model ID that looks like a flag is refused before anything launches", () => {
  const { bin, env } = setup();
  fakeTool(bin, "claude");
  const result = runCn(["claude", "--model", "--dangerously-skip-permissions"], { env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Not a valid model ID/);
  assert.equal(fs.existsSync(path.join(bin, "claude.record.json")), false);
});

test("the Codex catalog ranks models in cn's order, first model first", async () => {
  const { writeCodexCatalog } = await import("../lib/pickers.mjs");
  const dir = tempDir();
  const fakeCodex = path.join(dir, "codex");
  fs.writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const file = writeCodexCatalog(fakeCodex, [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }], path.join(dir, "models.json"));
  const ranks = JSON.parse(fs.readFileSync(file, "utf8")).models.map((m) => [m.slug, m.priority]);
  assert.deepEqual(ranks, [["a", 1], ["b", 2], ["c", 3]]);
});
