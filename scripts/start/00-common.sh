# shellcheck shell=bash
# Shared infrastructure: colors, helpers, AGENTEAM_DIR, git pull, ownership repair,
# and cross-platform utilities used by later phases.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
fail() { printf "${RED}✗${NC} %s\n" "$1"; exit 1; }
info() { printf "  %s\n" "$1"; }

# ── Pull latest code ──
if [ -d ".git" ]; then
  if git pull --ff-only 2>/dev/null; then
    ok "code up to date ($(git rev-parse --short HEAD))"
  else
    warn "git pull failed — continuing with current code ($(git rev-parse --short HEAD 2>/dev/null || echo 'unknown'))"
  fi
fi

# ── Shared paths (matches src/fs/state-dir.ts: AGENTEAM_STATE_DIR → ~/.agenteam) ──
AGENTEAM_DIR="${AGENTEAM_STATE_DIR:-$HOME/.agenteam}"

# ── Repair root-owned files from historical docker-exec-as-root ──
# MR !128 switched agent exec to host uid, but pre-existing files may still be root-owned.
# Run early so subsequent operations (SSH, Git, etc.) can access all files.
if [ "$(id -u)" -ne 0 ] && [ -d "$AGENTEAM_DIR/instances" ]; then
  _root_files=$(find "$AGENTEAM_DIR/instances" -user root ! -path '*/.git/*' ! -path '*/node_modules/*' -print -quit 2>/dev/null)
  if [ -n "$_root_files" ]; then
    warn "Found root-owned files under instances/ — repairing ownership..."
    if sudo chown -R "$(id -u):$(id -g)" "$AGENTEAM_DIR/instances" 2>/dev/null; then
      ok "file ownership repaired"
    else
      warn "could not auto-repair — run manually: sudo chown -R $(id -u):$(id -g) $AGENTEAM_DIR/instances"
    fi
  fi
fi

# Cross-platform port listening check (ss → lsof → nc fallback)
port_listening() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH "sport = :$port" 2>/dev/null | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || nc -z localhost "$port" 2>/dev/null
  else
    nc -z localhost "$port" 2>/dev/null
  fi
}

# Cross-platform package install (apt → dnf → yum → brew fallback)
pkg_install() {
  if command -v apt >/dev/null 2>&1; then
    sudo apt install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y "$@"
  elif command -v brew >/dev/null 2>&1; then
    brew install "$@"
  else
    return 1
  fi
}

# Detect Linux systemd service name for SSH (ssh on Debian/Ubuntu, sshd on RHEL/Arch)
detect_ssh_service() {
  if systemctl list-unit-files ssh.service >/dev/null 2>&1; then
    echo "ssh"
  else
    echo "sshd"
  fi
}

# Detect host sshd port (Linux: sshd_config → ss fallback → 22; macOS: 22).
detect_sshd_port() {
  [ "$(uname -s)" = "Darwin" ] && { echo 22; return; }
  local p=""
  [ -r /etc/ssh/sshd_config ] && p=$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/{print $2; exit}' /etc/ssh/sshd_config 2>/dev/null)
  [ -z "$p" ] && command -v ss >/dev/null 2>&1 && p=$(ss -tlnpH 2>/dev/null | awk '/sshd/{split($4,a,":"); print a[length(a)]; exit}')
  echo "${p:-22}"
}
