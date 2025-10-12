#!/usr/bin/env bash
set -euo pipefail

# Defaults (ajuste se quiser)
REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
WEB_DIR="${WEB_DIR:-/Users/daimaximila/hannaaialpha/hanna/apps/web}"
VERCEL_SCOPE="${VERCEL_SCOPE:-}"      # ex: douglas-projects-e4ca4334
VERCEL_PROJECT="${VERCEL_PROJECT:-}"  # ex: hanna-alpha

# Exporta variáveis de ambiente para o build
export NODE_ENV=production
export NEXT_PUBLIC_API_BASE="https://hannaalpha.onrender.com"
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export PORT="${PORT:-8080}"

# Mensagem de commit (arg1) ou padrão
MSG="${1:-chore: deploy}"

echo "🔧 Git add/commit/push ($REMOTE $BRANCH)…"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "❌ Não é um repo git aqui."; exit 1; }
git add -A
if git diff --cached --quiet; then
  echo "ℹ️  Sem mudanças staged. Seguindo mesmo assim…"
else
  git commit -m "$MSG" || true
fi
git push "$REMOTE" "$BRANCH"

echo "🚀 Deploy Vercel (produção) no diretório $WEB_DIR"
[ -d "$WEB_DIR" ] || { echo "❌ Pasta $WEB_DIR não existe."; exit 1; }
cd "$WEB_DIR"

# Garante que o projeto está “linkado” (cria .vercel se faltar)
if [ ! -d ".vercel" ]; then
  echo "🔗 Linkando projeto Vercel…"
  if [ -n "$VERCEL_SCOPE" ]; then
    vercel link --scope "$VERCEL_SCOPE" --yes
  else
    vercel link --yes
  fi
fi

# Monta flags (scope/projeto são opcionais)
FLAGS=( --prod --confirm )
[ -n "$VERCEL_SCOPE" ] && FLAGS+=( --scope "$VERCEL_SCOPE" )
[ -n "$VERCEL_PROJECT" ] && FLAGS+=( --project "$VERCEL_PROJECT" )

echo "💼 Rodando: vercel ${FLAGS[*]}"
vercel "${FLAGS[@]}"

echo "✅ Done!"
