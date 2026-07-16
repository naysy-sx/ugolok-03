#!/bin/bash
# worker.sh — задание локальному воркеру (qwen2.5-coder через Ollama)
#
#   ./worker.sh "задание"                     ответ в stdout
#   ./worker.sh "задание" путь/к/файлу        ответ (очищенный) в файл
#   ./worker.sh --ctx f1,f2 "задание" [файл]  вклеить файлы контекстом
MODEL="${WORKER_MODEL:-qwen2.5-coder:7b}"

CTX=""
if [ "$1" = "--ctx" ]; then
  IFS=',' read -ra FILES <<< "$2"
  for f in "${FILES[@]}"; do
    if [ -f "$f" ]; then
      CTX="$CTX
--- $f ---
$(cat "$f")"
    else
      echo "warning: ctx file not found: $f" >&2
    fi
  done
  shift 2
fi

TASK="$1"
OUT="$2"

if [ -n "$CTX" ]; then
  PROMPT="Справочный контекст (только для сведения, не переписывай его):
$CTX

Задание:
$TASK"
else
  PROMPT="$TASK"
fi

RESULT="$(curl -s http://localhost:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "$(node -e '
    const [model, prompt] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096
    }));
  ' "$MODEL" "$PROMPT")" \
| node -e '
  let d = "";
  process.stdin.on("data", c => d += c).on("end", () => {
    let out;
    try {
      const j = JSON.parse(d);
      out = j.choices?.[0]?.message?.content ?? d;
    } catch { out = d; }
    out = out.trim();
    // срезать markdown-обёртку, если воркер её добавил
    const m = out.match(/^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?```\s*$/);
    if (m) out = m[1];
    process.stdout.write(out);
  })')"

if [ -n "$OUT" ]; then
  printf '%s\n' "$RESULT" > "$OUT"
  echo "written: $OUT, $(wc -l < "$OUT" | tr -d ' ') lines"
else
  printf '%s\n' "$RESULT"
fi