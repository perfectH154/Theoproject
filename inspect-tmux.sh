#!/usr/bin/env bash
set -euo pipefail
tmux -S /var/lib/companion/tmux/theo-v2.sock ls 2>/dev/null || true
while IFS=: read -r session rest; do
  [[ -n "$session" ]] || continue
  echo "===${session}==="
  tmux -S /var/lib/companion/tmux/theo-v2.sock capture-pane -pt "$session" -S -120 | tail -100 || true
done < <(tmux -S /var/lib/companion/tmux/theo-v2.sock ls 2>/dev/null || true)
