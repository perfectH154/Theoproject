set -euo pipefail
find /root/.claude/projects -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -5 | cut -d' ' -f2- | while IFS= read -r f; do
  echo "====$f"
  tail -n 5 "$f" || true
done
