import { spawnSync } from "node:child_process";

import { API_ROOT } from "../catalog.mjs";
import { opencodeConfig } from "../pickers.mjs";

// v2 talks to a shared background service unless told to run privately, and
// that service would ignore our config. v1 has no such flag and rejects it.
// Help text is the direct signal; the major version backs it up in case help changes.
function supportsStandalone(executable) {
  const help = spawnSync(executable, ["--help"], { encoding: "utf8", timeout: 10000 });
  if (/--standalone/.test(`${help.stdout ?? ""}${help.stderr ?? ""}`)) return true;
  const out = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10000 });
  const major = Number(/(\d+)\.\d+/.exec(out.stdout ?? "")?.[1]);
  return major >= 2;
}

// The flag goes after a subcommand ("run --standalone ..."), or first for the interactive screen.
export function withStandalone(forwarded) {
  if (forwarded.length && !forwarded[0].startsWith("-")) {
    return [forwarded[0], "--standalone", ...forwarded.slice(1)];
  }
  return ["--standalone", ...forwarded];
}

export default {
  id: "opencode",
  label: "OpenCode",
  binary: "opencode",
  installHint: "Install OpenCode (https://opencode.ai), then run cn opencode again.",

  version(executable) {
    const out = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10000 });
    return (out.stdout ?? "").trim().split("\n")[0] || null;
  },

  async prepare({ executable, model, key, available, forwarded }) {
    const config = JSON.stringify(opencodeConfig(API_ROOT, model, available));
    return {
      args: supportsStandalone(executable) ? withStandalone(forwarded) : forwarded,
      env: { OPENCODE_CONFIG_CONTENT: config, CONCENTRATE_API_KEY: key },
      cleanup() {},
    };
  },
};
