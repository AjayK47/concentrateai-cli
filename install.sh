#!/usr/bin/env bash
# Installs the Concentrate AI CLI (`cn`) from this directory. Needs Node.js 18+.
# There are no npm dependencies, so nothing is downloaded.
set -euo pipefail

MIN_NODE_MAJOR=18
package_dir="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/concentrate-cli"
bin_dir="$HOME/.local/bin"
launcher="$bin_dir/cn"
marker="# concentrate-cli launcher"

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

node_ok() {
  command -v node >/dev/null 2>&1 && [[ "$(node_major)" =~ ^[0-9]+$ ]] && (( "$(node_major)" >= MIN_NODE_MAJOR ))
}

node_help() {
  echo "Install Node.js ${MIN_NODE_MAJOR}+ and rerun this installer:" >&2
  echo "  - https://nodejs.org/en/download" >&2
  echo "  - nvm: https://github.com/nvm-sh/nvm#installing-and-updating" >&2
}

ensure_node() {
  node_ok && return 0
  if command -v node >/dev/null 2>&1; then
    echo "Node.js ${MIN_NODE_MAJOR}+ is required (found $(node -p process.versions.node))." >&2
  else
    echo "Node.js ${MIN_NODE_MAJOR}+ is required." >&2
  fi
  if [[ "$(uname -s)" == "Darwin" ]] && command -v brew >/dev/null 2>&1 && [[ -r /dev/tty ]]; then
    local answer
    read -r -p "Install Node.js with Homebrew now? [y/N] " answer </dev/tty
    if [[ "$answer" =~ ^[Yy]$ ]]; then
      brew install node
      node_ok && return 0
    fi
  fi
  node_help
  exit 1
}

# A different `cn` (for example the Python package's) must not be overwritten.
check_launcher() {
  if [[ -e "$launcher" || -L "$launcher" ]]; then
    if [[ -L "$launcher" ]] || ! grep -q "^${marker}$" "$launcher" 2>/dev/null; then
      echo "A different cn command already exists at $launcher. Move it before installing." >&2
      exit 1
    fi
  fi
}

ensure_node
check_launcher

node_bin="$(command -v node)"
rm -rf "$install_dir"
mkdir -p "$install_dir" "$bin_dir"
cp -R "$package_dir/bin" "$package_dir/lib" "$package_dir/package.json" "$install_dir/"

# Paths are embedded single-quoted, so spaces, $, quotes, or backticks in them stay literal.
sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

{
  printf '%s\n' '#!/bin/sh' "$marker"
  printf 'NODE_BIN="${CN_NODE_BIN:-}"\n'
  printf '[ -n "$NODE_BIN" ] || NODE_BIN=%s\n' "$(sh_quote "$node_bin")"
  cat <<'LAUNCHER'
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ]; then
  echo "cn: Node.js was not found. Install Node 18+ and rerun the installer." >&2
  exit 127
fi
LAUNCHER
  printf 'exec "$NODE_BIN" %s "$@"\n' "$(sh_quote "$install_dir/bin/cn.mjs")"
} >"$launcher"
chmod 755 "$launcher"

printf '\nInstalled Concentrate AI at %s\n' "$launcher"
case ":$PATH:" in
  *":$bin_dir:"*) printf 'Run: cn setup\n' ;;
  *)
    case "${SHELL:-}" in
      */zsh) rc_file="$HOME/.zshrc" ;;
      */bash) rc_file="$HOME/.bashrc" ;;
      *) rc_file="your shell startup file" ;;
    esac
    printf 'Add this line to %s:\n  export PATH="$HOME/.local/bin:$PATH"\n' "$rc_file"
    printf 'Then open a new terminal and run: cn setup\n'
    ;;
esac
