#!/bin/sh
# dsh cc-tui with a forge workspace side panel: cc-tui on the left,
# the live explorer/viewer (workspace-panel TUI host) on the right.
# Usage: dsh-tui-sidecar.sh [workspace-dir]
set -e
SESSION=dsh-sidecar
DIR="${1:-$PWD}"
HOST="$HOME/workspace/dsh_forge/examples/workspace-panel/tui-host.ts"

tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION"
tmux new-session -d -s "$SESSION" "dsh --profile cc-tui"
tmux split-window -h -l 30% -t "$SESSION" "node '$HOST' '$DIR'"
tmux select-pane -t "$SESSION:0.0"
tmux attach -t "$SESSION"
