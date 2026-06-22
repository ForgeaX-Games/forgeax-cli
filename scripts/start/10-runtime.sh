# shellcheck shell=bash
# Language-runtime prereqs: git, Node.js (with discovery + nvm fallback), pnpm,
# C++ toolchain (for native node addons), and the project's pnpm install.

# ── git (required for pack version management & instance sync) ──
if ! command -v git >/dev/null 2>&1; then
  warn "git not found — installing (required for pack version management)..."
  pkg_install git \
    || fail "git not found. Install with your package manager: apt/brew install git"
fi
# Extract git major.minor using sed+cut (POSIX-compatible, no grep -oP)
GIT_VER=$(git version | sed 's/[^0-9.]//g' | cut -d. -f1-2)
GIT_MAJOR="${GIT_VER%%.*}"
GIT_MINOR="${GIT_VER##*.}"
if [ "$GIT_MAJOR" -ge 3 ] 2>/dev/null || \
   { [ "$GIT_MAJOR" -eq 2 ] && [ "${GIT_MINOR:-0}" -ge 25 ]; }; then
  :
else
  warn "git >= 2.25 recommended (found $(git version))"
fi
ok "$(git version)"

# ── Node.js ──
# 非 login bash 不 source .bashrc / /etc/profile，许多 node 安装方式（nvm、asdf shims、snap、
# linuxbrew、xdg ~/.local/bin、手动 tarball、nodesource via /etc/profile.d）的路径不在默认 PATH。
# 直接扫一遍常见目录，比 source 配置文件安全（不会带入 alias / set -e 等副作用）。
if ! command -v node >/dev/null 2>&1; then
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  for _d in \
    "$HOME/.local/bin" "$HOME/bin" \
    "$HOME/.local/share/fnm" "$HOME/.fnm" \
    "$HOME/.volta/bin" "$HOME/.local/share/pnpm" \
    "$HOME/n/bin" "$HOME/.nodenv/shims" "$HOME/.asdf/shims" \
    "/usr/local/bin" "/snap/bin" \
    "/opt/homebrew/bin" "/home/you/.linuxbrew/bin" \
    "/opt/nodejs/bin"; do
    [ -d "$_d" ] && case ":$PATH:" in *":$_d:"*) ;; *) export PATH="$_d:$PATH" ;; esac
  done
  command -v fnm >/dev/null 2>&1 && eval "$(fnm env)" >/dev/null 2>&1 || true
fi
# 真没装 → 用 nvm 兜底装一份用户级 Node 22（不需要 sudo、不污染系统包管理器、易卸载）。
if ! command -v node >/dev/null 2>&1; then
  warn "node not found on PATH"
  if [ -t 0 ]; then
    printf "  Auto-install Node.js 22 via nvm (user-level, no sudo)? [Y/n]: "
    read -r _ans
    case "$_ans" in n|N) fail "node not installed. Install Node.js >= 22 manually then re-run." ;; esac
  else
    info "Non-interactive shell — auto-installing Node.js 22 via nvm"
  fi
  command -v curl >/dev/null 2>&1 || fail "curl required for nvm install. apt/brew install curl, then re-run."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
    || fail "nvm install script failed (check network / GitHub access)"
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" || fail "nvm installed but $NVM_DIR/nvm.sh missing"
  nvm install 22 || fail "nvm install 22 failed"
  ok "Node.js installed via nvm"
fi
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || fail "Node.js >= 22 required (found v$(node -v))"
ok "node $(node -v)"

# ── pnpm ──
if ! command -v pnpm >/dev/null 2>&1; then
  warn "pnpm not found — installing via npm..."
  npm i -g pnpm || fail "Failed to install pnpm. Run manually: npm i -g pnpm"
fi
ok "pnpm $(pnpm -v)"

# ── pnpm global bin dir ──
if [ -z "${PNPM_HOME:-}" ]; then
  export PNPM_HOME="$HOME/.local/share/pnpm"
  mkdir -p "$PNPM_HOME"
  grep -q 'PNPM_HOME' "$HOME/.bashrc" 2>/dev/null || pnpm setup >/dev/null 2>&1 || true
fi
PNPM_BIN_DIR="$(pnpm bin -g 2>/dev/null || echo "$PNPM_HOME")"
case ":$PATH:" in *":$PNPM_BIN_DIR:"*) ;; *) export PATH="$PNPM_BIN_DIR:$PATH" ;; esac
ok "PNPM_HOME=$PNPM_HOME"

# ── C++ toolchain (needed for native addons like better-sqlite3) ──
_need_gxx_install=false
if ! command -v g++ >/dev/null 2>&1; then
  _need_gxx_install=true
elif ! g++ -std=c++20 -x c++ -E /dev/null >/dev/null 2>&1; then
  _gxx_ver=$(g++ -dumpversion 2>/dev/null || echo "unknown")
  warn "g++ $_gxx_ver does not support C++20"
  # Try to activate an existing gcc-toolset first
  for _ts in 14 13 12; do
    _enable="/opt/rh/gcc-toolset-${_ts}/enable"
    if [ -f "$_enable" ]; then
      # shellcheck disable=SC1090
      source "$_enable"
      if g++ -std=c++20 -x c++ -E /dev/null >/dev/null 2>&1; then
        ok "g++ $(g++ -dumpversion) activated via gcc-toolset-${_ts}"
        break
      fi
    fi
  done
  if ! g++ -std=c++20 -x c++ -E /dev/null >/dev/null 2>&1; then
    _need_gxx_install=true
  fi
fi

if $_need_gxx_install; then
  warn "C++20-capable g++ not available — installing..."
  if [ "$(uname -s)" = "Linux" ]; then
    if command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y gcc-toolset-12-gcc-c++ 2>&1 | tail -3 \
        && source /opt/rh/gcc-toolset-12/enable 2>/dev/null \
        || warn "dnf install gcc-toolset-12 failed"
    elif command -v yum >/dev/null 2>&1; then
      sudo yum install -y gcc-toolset-12-gcc-c++ 2>&1 | tail -3 \
        && source /opt/rh/gcc-toolset-12/enable 2>/dev/null \
        || warn "yum install gcc-toolset-12 failed"
    elif command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update -qq && sudo apt-get install -y g++ 2>&1 | tail -3 \
        || warn "apt-get install g++ failed"
    fi
  fi
  if command -v g++ >/dev/null 2>&1 && g++ -std=c++20 -x c++ -E /dev/null >/dev/null 2>&1; then
    ok "g++ $(g++ -dumpversion) installed and supports C++20"
  elif command -v g++ >/dev/null 2>&1; then
    warn "g++ installed but still does not support C++20 — native addons may fail to compile"
  else
    warn "g++ installation failed — native addons will fail to compile"
  fi
else
  if command -v g++ >/dev/null 2>&1; then
    ok "g++ $(g++ -dumpversion) supports C++20"
  fi
fi

# ── pnpm install ──
# 用 --frozen-lockfile 避免污染 lock；失败时按错误类型给出可执行修复建议。
# 关键前提：pnpm-workspace.yaml 里的 allowBuilds 必须涵盖所有 native 包
# （pnpm 11 不再读 package.json#pnpm，未列入的 native 包会触发 ERR_PNPM_IGNORED_BUILDS）。
if [ ! -d "node_modules" ] || [ ! -f "node_modules/.pnpm/lock.yaml" ] || [ "pnpm-lock.yaml" -nt "node_modules/.pnpm/lock.yaml" ]; then
  warn "Dependencies may be outdated, running pnpm install..."
  PNPM_LOG=$(mktemp)
  if ! pnpm install --frozen-lockfile 2>&1 | tee "$PNPM_LOG"; then
    if grep -q "ERR_PNPM_IGNORED_BUILDS" "$PNPM_LOG"; then
      pkgs=$(grep "Ignored build scripts" "$PNPM_LOG" | sed -E 's/.*Ignored build scripts: //' | tr ',' '\n' | sed -E 's/@[^@,]+$//' | tr -d ' ')
      printf '\nAdd these lines to pnpm-workspace.yaml under `allowBuilds:` and re-run:\n%s\n' "$(echo "$pkgs" | sed 's/^/  /;s/$/: true/')"
      fail "pnpm 11 blocked native build scripts (see above)"
    fi
    warn "frozen install failed — resetting pnpm-lock.yaml to HEAD and retrying"
    [ -d ".git" ] && git checkout -- pnpm-lock.yaml 2>/dev/null || true
    pnpm install --frozen-lockfile || fail "pnpm install failed — see $PNPM_LOG"
  fi
  ok "dependencies installed"
else
  ok "dependencies up to date"
fi
