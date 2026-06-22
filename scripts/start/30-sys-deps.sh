# shellcheck shell=bash
# Small system packages: rsync (pack↔team file sync), zip/unzip (team backup),
# socat (container port forwarding). Auto-installed via pkg_install when missing.

# ── rsync (required for pack↔team file sync) ──
if ! command -v rsync >/dev/null 2>&1; then
  warn "rsync not found — installing (required for pack↔team sync)..."
  pkg_install rsync \
    || fail "rsync not found. Install with your package manager: apt/brew install rsync"
fi
ok "rsync installed"

# ── zip / unzip (required for team backup & restore) ──
MISSING_ARCHIVER=()
command -v zip   >/dev/null 2>&1 || MISSING_ARCHIVER+=(zip)
command -v unzip >/dev/null 2>&1 || MISSING_ARCHIVER+=(unzip)
if [ ${#MISSING_ARCHIVER[@]} -gt 0 ]; then
  warn "${MISSING_ARCHIVER[*]} not found — installing (required for team backup/restore)..."
  pkg_install "${MISSING_ARCHIVER[@]}" \
    || fail "${MISSING_ARCHIVER[*]} not found. Install with your package manager: apt/brew install ${MISSING_ARCHIVER[*]}"
fi
ok "zip/unzip installed"

# ── socat (required for container port forwarding) ──
if ! command -v socat >/dev/null 2>&1; then
  warn "socat not found — installing (required for container port forwarding)..."
  pkg_install socat \
    || fail "socat not found. Install with your package manager: apt/brew install socat"
fi
ok "socat $(socat -V 2>&1 | grep -o 'version [0-9.]*' | head -1)"
