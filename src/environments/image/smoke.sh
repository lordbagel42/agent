#!/bin/bash
set -euo pipefail
test "$(id -u)" != 0
test -w /workspace
python3 -c 'assert 7 * 9 == 63'
node -e 'if (7 * 9 !== 63) process.exit(1)'
git --version
agent-browser --version
chromium --version

session="june-smoke-$$"
directory="$(mktemp -d)"
snapshot="${1:-$directory/browser.png}"
cleanup() {
  agent-browser --session "$session" close >/dev/null 2>&1 || true
  rm -rf "$directory"
}
trap cleanup EXIT
cat > "$directory/page.html" <<'HTML'
<!doctype html><title>June VM smoke</title>
<button onclick="this.textContent='verified'">check</button>
HTML
agent-browser --session "$session" open "file://$directory/page.html"
agent-browser --session "$session" set viewport 1280 720 2
agent-browser --session "$session" snapshot -i
agent-browser --session "$session" find role button click --name check
agent-browser --session "$session" get text button | grep -qx verified
agent-browser --session "$session" screenshot "$snapshot"
test -s "$snapshot"
agent-browser --session "$session" close
printf 'June environment smoke passed: shell, Python, Node, Git, browser interaction and screenshot.\n'
