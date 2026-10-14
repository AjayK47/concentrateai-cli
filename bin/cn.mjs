#!/usr/bin/env node
// Checked before loading anything else, so an old Node gets a clear message, not a stack trace.
const major = Number(process.versions.node.split(".")[0]);
if (major < 18) {
  process.stderr.write(`cn needs Node.js 18 or newer (this is ${process.version}).\n`);
  process.exit(1);
}

const { main } = await import("../lib/cli.mjs");
process.exitCode = await main();
