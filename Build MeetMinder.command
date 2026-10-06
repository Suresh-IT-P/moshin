#!/bin/bash
#
# Double-click this file on a Mac to build MeetMinder's installer (.dmg).
#
# Everything it needs stays inside this folder: if Node.js isn't installed, a private
# copy is downloaded into .tools/ (no admin password, nothing installed system-wide).
# The finished .dmg is saved in the dist/ folder and opened for you.

set -euo pipefail
unset ELECTRON_RUN_AS_NODE

cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"
NODE_RELEASE_LINE=24 # Node.js version downloaded when needed
MIN_NODE_MAJOR=20    # an installed Node.js older than this is not used

bold=$'\033[1m'
dim=$'\033[2m'
red=$'\033[31m'
green=$'\033[32m'
reset=$'\033[0m'

step() { printf '\n%s%s%s\n' "$bold" "$*" "$reset"; }

fail() {
  trap - ERR
  printf '\n%s✗ %s%s\n' "$red$bold" "$*" "$reset"
  printf 'Fix the problem above, then double-click the script again.\n'
  exit 1
}
trap 'fail "The build stopped because of the error above."' ERR

clear 2>/dev/null || true
printf '%sMeetMinder — build the Mac app%s\n' "$bold" "$reset"
printf '%sThe first build takes a few minutes. You can leave this window open and do something else.%s\n' "$dim" "$reset"

[ "$(uname -s)" = "Darwin" ] || fail "This script builds the Mac app, so it has to run on a Mac."

if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
  arch="arm64"
  chip="Apple Silicon"
else
  arch="x64"
  chip="Intel"
fi

# ----------------------------------------------------------------------------- Node.js

step "1/3  Checking Node.js"
local_node="$PROJECT_DIR/.tools/node"
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if [ -x "$local_node/bin/node" ]; then
  export PATH="$local_node/bin:$PATH"
elif command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge "$MIN_NODE_MAJOR" ]; then
  : # use the Node.js that is already installed
else
  echo "Node.js isn't installed, so a private copy is being downloaded into this folder…"
  dist_url="https://nodejs.org/dist/latest-v$NODE_RELEASE_LINE.x"
  line="$(curl -fsSL "$dist_url/SHASUMS256.txt" | grep -E "node-v[0-9.]+-darwin-$arch\.tar\.gz$")" ||
    fail "Couldn't reach nodejs.org. Check the internet connection and try again."
  checksum="${line%% *}"
  file="${line##* }"
  tmp="$(mktemp -d)"
  curl -fL --progress-bar "$dist_url/$file" -o "$tmp/$file" ||
    fail "Downloading Node.js failed. Check the internet connection and try again."
  echo "$checksum  $tmp/$file" | shasum -a 256 -c - >/dev/null ||
    fail "The Node.js download was damaged. Try again."
  rm -rf "$local_node"
  mkdir -p "$local_node"
  tar -xzf "$tmp/$file" -C "$local_node" --strip-components 1
  rm -rf "$tmp"
  "$local_node/bin/node" -v >/dev/null 2>&1 || {
    rm -rf "$local_node"
    fail "Node.js could not be set up. Try again."
  }
  export PATH="$local_node/bin:$PATH"
fi
echo "Using Node.js $(node -v)  ${dim}$(command -v node)${reset}"

# ------------------------------------------------------------------------ dependencies

step "2/3  Installing the build tools"
npm ci --no-audit --no-fund --loglevel=error

# ------------------------------------------------------------------------------ build

step "3/3  Building MeetMinder for this Mac ($chip)"
rm -f dist/*.dmg dist/*.dmg.blockmap
./node_modules/.bin/electron-builder --mac dmg "--$arch" --publish never

dmg="$(ls -t dist/*-"$arch".dmg 2>/dev/null | head -n 1 || true)"
[ -n "$dmg" ] || fail "The build finished, but no .dmg was found in the dist folder."

size="$(du -h "$dmg" | cut -f1 | tr -d ' ')"
printf '\n%s✓ Done in %dm %02ds.%s\n' "$green$bold" $((SECONDS / 60)) $((SECONDS % 60)) "$reset"
printf 'Your installer (%s): %s\n\n' "$size" "$PROJECT_DIR/$dmg"
echo "Opening it now: drag MeetMinder into the Applications folder, then open it from Applications or Launchpad."
open -R "$dmg"
open "$dmg"
