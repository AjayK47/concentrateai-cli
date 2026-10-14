import readline from "node:readline";

import { CnError } from "./errors.mjs";

let reader = null;
let lines = null;

function lineIterator() {
  if (!lines) {
    reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines = reader[Symbol.asyncIterator]();
  }
  return lines;
}

export async function ask(question) {
  process.stdout.write(question);
  const { value, done } = await lineIterator().next();
  if (done) throw new CnError("Input ended before an answer was given");
  // Piped input is not echoed, so end the prompt line ourselves.
  if (!process.stdin.isTTY) process.stdout.write("\n");
  return value.trim();
}

// Call hidden prompts before any ask(): both read process.stdin.
export function askHidden(question) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return ask(question);
  return new Promise((resolve, reject) => {
    let buffer = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stdout.write("\n");
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          finish();
          resolve(buffer.trim());
          return;
        }
        if (char === "\u0003") {
          finish();
          reject(new CnError("Cancelled", 130));
          return;
        }
        if (char === "\u007f" || char === "\b") buffer = buffer.slice(0, -1);
        else buffer += char;
      }
    };
    stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export function closePrompts() {
  if (reader) reader.close();
  reader = null;
  lines = null;
}
