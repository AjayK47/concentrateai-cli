import { browseModels, runDoctor, runSetup } from "./commands.mjs";
import { launch, which } from "./launch.mjs";
import { listHarnesses } from "./harnesses/registry.mjs";
import { needsSetup, readPreferences, resolveKey } from "./settings.mjs";
import { focusIn, header } from "./ui/brand.mjs";
import { caps, paint } from "./ui/term.mjs";
import { glyphs } from "./ui/theme.mjs";
import { select } from "./ui/widgets.mjs";
import { version } from "./version.mjs";

const MANAGE = [
  { value: "setup", label: "setup", note: "Save or replace your key", about: "Save or replace your Concentrate AI key." },
  { value: "models", label: "models", note: "Browse the live catalog", about: "Search every model by name, context window, and capability." },
  { value: "doctor", label: "doctor", note: "Check installs, key, and routes", about: "Find which tools are installed and whether your key works." },
];

// A quiet dot when a tool is ready; words only when something needs attention.
function toolStatus(installed, hasKey, c) {
  const g = glyphs(c);
  if (!installed) return paint("mute", `${g.off} not installed`, {}, c);
  if (!hasKey) return paint("focus", `${g.half} needs a key`, {}, c);
  return paint("ok", g.ok, {}, c);
}

export function menuItems(env, c = caps()) {
  const { key, source } = resolveKey(env);
  const preferences = readPreferences(env);
  const tools = listHarnesses().map((adapter) => {
    const installed = Boolean(which(adapter.binary, env.PATH));
    return {
      value: `tool:${adapter.id}`,
      label: adapter.id,
      note: adapter.label,
      meta: preferences[adapter.id],
      right: toolStatus(installed, Boolean(key), c),
      ready: installed && Boolean(key),
      about: !installed
        ? adapter.installHint
        : `Starts ${adapter.label} on ${preferences[adapter.id]}. Change it with cn model ${adapter.id}.`,
    };
  });
  const ready = tools.filter((tool) => tool.ready).length;
  const g = glyphs(c);
  const keyLine = key
    ? `${paint("ok", g.ok, {}, c)} ${paint("mute", source === "stored" ? "key saved" : "key from environment", {}, c)}`
    : `${paint("focus", g.half, {}, c)} ${paint("mute", "no key yet", {}, c)}`;
  return {
    items: [{ group: "launch" }, ...tools, { group: "manage" }, ...MANAGE],
    initial: tools.find((tool) => tool.ready)?.value ?? tools[0].value,
    status: `${keyLine}   ${paint("mute", `${ready} of ${tools.length} tools ready`, {}, c)}`,
  };
}

export async function runLauncher(env = process.env) {
  const c = caps();
  if (needsSetup(env)) {
    // First run: there is nothing to launch with yet, so start with setup.
    await runSetup({}, env);
    console.log();
  } else {
    await focusIn(c);
  }
  console.log(header(version(), { status: menuItems(env, c).status }, c).join("\n") + "\n");
  for (;;) {
    const { items, initial } = menuItems(env, c);
    const choice = await select({
      items,
      initial,
      rows: 14,
      detail: (item) => [item.about],
      hints: [["↑↓", "move"], ["↵", "open"], ["q", "quit"]],
    });
    if (choice.cancel) return 0;
    if (choice.value.startsWith("tool:")) {
      if (!resolveKey(env).key) await runSetup({ showHeader: false }, env);
      return launch(choice.value.slice(5), {}, env);
    }
    if (choice.value === "setup") await runSetup({ showHeader: false }, env);
    else if (choice.value === "models") await browseModels(env);
    else return runDoctor({}, env);
  }
}
