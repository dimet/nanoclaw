---
name: token-usage
description: Report Claude API token usage and cost from session logs. Use when the user asks about usage, cost, spend, or tokens.
---

# /token-usage — Cost & Token Usage

Data source: `/workspace/project/store/token-usage.jsonl` — one JSON record per line.

Fields: `timestamp` (ISO), `channel`, `model`, `input_tokens`, `output_tokens`, `cost_usd`

## Snippets

**Total spend to date**
```bash
jq -r '.cost_usd' /workspace/project/store/token-usage.jsonl \
  | awk '{s+=$1} END {printf "$%.4f\n", s}'
```

**Spend by model**
```bash
jq -r '[.model, .cost_usd] | @tsv' /workspace/project/store/token-usage.jsonl \
  | awk -F'\t' '{c[$1]+=$2} END {for (m in c) printf "%s  $%.4f\n", m, c[m]}'
```

**Spend by day**
```bash
jq -r '[(.timestamp | split("T")[0]), .cost_usd] | @tsv' /workspace/project/store/token-usage.jsonl \
  | awk -F'\t' '{c[$1]+=$2} END {for (d in c) printf "%s  $%.4f\n", d, c[d]}' | sort
```

**Last 20 sessions**
```bash
tail -n 20 /workspace/project/store/token-usage.jsonl \
  | jq -r '[.timestamp, .model, .input_tokens, .output_tokens, (.cost_usd | tostring)] | join("  ")'
```

**Today's spend**
```bash
TODAY=$(date +%Y-%m-%d)
jq -r --arg d "$TODAY" 'select(.timestamp | startswith($d)) | .cost_usd' \
  /workspace/project/store/token-usage.jsonl \
  | awk '{s+=$1} END {printf "$%.4f\n", s}'
```

## Formatting

Always present results in a fenced code block. Never use markdown tables.
