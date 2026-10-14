import {
  runDoctor,
  runKey,
  runLogout,
  runModel,
  runReset,
  runSetup,
  showConfig,
  showModels,
} from "./commands.mjs";
import { CnError, EXIT } from "./errors.mjs";
import { isModelId } from "./safe.mjs";
import { getHarness, isHarness, listHarnesses } from "./harnesses/registry.mjs";
import { launch, which } from "./launch.mjs";
import { runLauncher } from "./launcher.mjs";
import { closePrompts } from "./prompt.mjs";
import { needsSetup } from "./settings.mjs";
import { ledger } from "./ui/layout.mjs";
import { interactive } from "./ui/widgets.mjs";
import { version } from "./version.mjs";

const HELP = `cn - Concentrate AI: one key for every coding agent

Usage:
  cn <tool> [--model <id>] [-- <tool args>]   Launch a tool through Concentrate AI
      tools: ${listHarnesses().map((h) => h.id).join(", ")}
  cn setup [--no-verify] [--models]           Save your API key (--models also picks defaults)
  cn config                                   Show key status and default models
  cn key [--no-verify]                        Replace the saved API key
  cn logout                                   Remove the saved API key
  cn reset [--yes] [--sessions]               Clear everything cn saved and start fresh
  cn model [<tool> [<model-id>]]              Show or change default models
  cn models [<tool>] [--search <text>] [--refresh] [--limit <n>]
  cn doctor [<tool>]                          Check installs, key, and API route
  cn --version
`;

function usageError(message) {
  return new CnError(`${message}\nRun cn --help for usage.`, EXIT.USAGE);
}

export function parseLaunchArgs(rest) {
  let model;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--") return { model, forwarded: rest.slice(i + 1) };
    if (arg === "--model" || arg.startsWith("--model=")) {
      model = arg === "--model" ? rest[(i += 1)] : arg.slice("--model=".length);
      if (!model) throw usageError("--model needs a model ID");
      if (!isModelId(model)) throw usageError(`Not a valid model ID: ${JSON.stringify(model).slice(0, 80)}`);
    } else {
      return { model, forwarded: rest.slice(i) };
    }
  }
  return { model, forwarded: [] };
}

export function parseFlags(rest, { booleans = [], values = [] } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (booleans.includes(name)) {
      flags[name] = true;
    } else if (values.includes(name)) {
      if (i + 1 >= rest.length) throw usageError(`--${name} needs a value`);
      flags[name] = rest[(i += 1)];
    } else {
      throw usageError(`Unknown option: ${arg}`);
    }
  }
  return { flags, positionals };
}

function toolArg(value) {
  if (value !== undefined && !isHarness(value)) {
    throw usageError(`Unknown tool: ${value}. Choose one of: ${listHarnesses().map((h) => h.id).join(", ")}`);
  }
  return value;
}

async function dispatch(argv, env) {
  const [command, ...rest] = argv;
  if (!command && interactive(env)) return runLauncher(env);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(version());
    return 0;
  }
  if (isHarness(command)) {
    const adapter = getHarness(command);
    // A missing tool is reported by launch() without making anyone set up first.
    if (interactive(env) && needsSetup(env) && which(adapter.binary, env.PATH)) {
      console.log(ledger("warn", "setup", "no API key yet, let's set one up\n"));
      await runSetup({}, env);
      console.log();
    }
    return launch(command, parseLaunchArgs(rest), env);
  }

  switch (command) {
    case "setup": {
      const { flags } = parseFlags(rest, { booleans: ["no-verify", "models"] });
      return runSetup({ verify: !flags["no-verify"], models: Boolean(flags.models) }, env);
    }
    case "key":
      return runKey({ verify: !parseFlags(rest, { booleans: ["no-verify"] }).flags["no-verify"] }, env);
    case "config":
      return showConfig(env);
    case "reset": {
      const { flags } = parseFlags(rest, { booleans: ["yes", "sessions"] });
      return runReset({ yes: Boolean(flags.yes), sessions: Boolean(flags.sessions) }, env);
    }
    case "logout":
      return runLogout(env);
    case "model": {
      const { positionals } = parseFlags(rest);
      return runModel({ target: toolArg(positionals[0]), modelId: positionals[1] }, env);
    }
    case "models": {
      const { flags, positionals } = parseFlags(rest, { booleans: ["refresh"], values: ["search", "limit"] });
      const limit = flags.limit === undefined ? 30 : Number(flags.limit);
      if (!Number.isInteger(limit) || limit < 1) throw usageError("--limit must be a positive number");
      return showModels({ target: toolArg(positionals[0]), search: flags.search, refresh: Boolean(flags.refresh), limit }, env);
    }
    case "doctor":
      return runDoctor({ target: toolArg(parseFlags(rest).positionals[0]) }, env);
    default:
      throw usageError(`Unknown command: ${command}`);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    return await dispatch(argv, env);
  } catch (error) {
    if (error instanceof CnError) {
      console.error(error.message);
      return error.exitCode;
    }
    console.error(`cn: unexpected error: ${error.message}`);
    if (env.CN_DEBUG) console.error(error.stack);
    return EXIT.FAILURE;
  } finally {
    closePrompts();
  }
}
