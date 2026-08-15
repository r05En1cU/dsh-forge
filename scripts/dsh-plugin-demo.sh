#!/bin/sh
# dsh cc-tui with the plugin-demo fabric sidebar.
# The tier-3 fabric patch stubs MUST be installed before dsh imports
# dsh-cc-tui's Chat screen, hence NODE_OPTIONS=--import of the bootstrap
# module is part of the same command — not a separate step.
# Usage: dsh-plugin-demo.sh
set -e

PROFILE="$HOME/.dsh/profiles/cc-tui"
BOOTSTRAP="$PROFILE/node_modules/dsh-plugin-demo/fabric-bootstrap.mjs"
SESSION=plugin-demo

if [ ! -f "$BOOTSTRAP" ]; then
  echo "plugin-demo is not installed in $PROFILE" >&2
  exit 1
fi

tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION"
exec tmux new-session -s "$SESSION" "NODE_OPTIONS='--import file://$BOOTSTRAP' dsh --profile cc-tui"
