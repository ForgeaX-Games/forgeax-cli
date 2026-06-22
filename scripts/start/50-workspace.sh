# shellcheck shell=bash
# Workspace state: ensure local packs/ dir, free up the Gateway port (auto-shutdown
# any stale process), and rebuild the Admin UI when source files are newer than dist.

# ── Ensure local packs directory exists ──
PACKS_DIR="$AGENTEAM_DIR/packs"
mkdir -p "$PACKS_DIR"
ok "packs directory ready (local-only, no remote git sync)"

# ── Check Gateway port & auto-shutdown stale process ──
GW_PORT=3700
if [ -f "$AGENTEAM_DIR/gateway.json" ]; then
  _p=$(AGENTEAM_DIR="$AGENTEAM_DIR" node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.env.AGENTEAM_DIR+'/gateway.json','utf-8')).port||$GW_PORT)}catch{console.log($GW_PORT)}" 2>/dev/null)
  [ -n "$_p" ] && GW_PORT="$_p"
fi

if port_listening "$GW_PORT"; then
  warn "Port $GW_PORT is occupied — attempting pnpm ctl shutdown..."
  pnpm ctl shutdown 2>/dev/null
  for i in $(seq 1 20); do
    port_listening "$GW_PORT" || break
    sleep 0.5
  done
  if port_listening "$GW_PORT"; then
    fail "Port $GW_PORT still occupied after shutdown. Kill the process manually:\n  lsof -ti :$GW_PORT | xargs kill -9"
  fi
  ok "previous Gateway stopped"
else
  ok "port $GW_PORT available"
fi

# ── Admin UI ──
if [ -d "ui" ]; then
  if [ ! -d "ui/node_modules" ] || \
     [ ! -f "ui/node_modules/.pnpm/lock.yaml" ] || \
     { [ -f "ui/pnpm-lock.yaml" ] && \
       [ "ui/pnpm-lock.yaml" -nt "ui/node_modules/.pnpm/lock.yaml" ]; }; then
    warn "UI dependencies missing or outdated, running pnpm install in ui/..."
    (cd ui && pnpm install --frozen-lockfile 2>/dev/null || pnpm install)
  fi

  UI_NEEDS_BUILD=false
  if [ ! -d "ui/dist" ]; then
    UI_NEEDS_BUILD=true
  else
    UI_BUILD_MARKER="ui/dist/index.html"
    if [ ! -f "$UI_BUILD_MARKER" ]; then
      UI_NEEDS_BUILD=true
    elif [ -n "$(find ui/src ui/public ui/index.html ui/vite.config.ts \
                  ui/tsconfig.json ui/tsconfig.app.json ui/tsconfig.node.json ui/package.json \
                  -newer "$UI_BUILD_MARKER" -print -quit 2>/dev/null)" ]; then
      UI_NEEDS_BUILD=true
    fi
  fi

  if [ "$UI_NEEDS_BUILD" = true ]; then
    warn "UI outdated or missing, rebuilding..."
    (cd ui && pnpm build)
    ok "UI built"
  else
    ok "UI dist up to date"
  fi
fi
