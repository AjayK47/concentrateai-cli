import claude from "./claude.mjs";
import codex from "./codex.mjs";
import opencode from "./opencode.mjs";
import pi from "./pi.mjs";

const REGISTRY = new Map([claude, codex, opencode, pi].map((adapter) => [adapter.id, adapter]));

export function isHarness(id) {
  return REGISTRY.has(id);
}

export function getHarness(id) {
  return REGISTRY.get(id);
}

export function listHarnesses() {
  return [...REGISTRY.values()];
}
