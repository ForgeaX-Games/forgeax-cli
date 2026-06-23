# shellcheck shell=bash
# SSH stack:
#   - read or auto-generate a sandbox SSH key + persist its path into agenteam.json
#   - resolve sshd port (config → detect → 22) + persist
#   - install / start sshd (Linux: openssh-server + systemctl; macOS: Remote Login)
#   - add own pub key to ~/.ssh/authorized_keys (idempotent)
#   - test SSH connectivity to the configured git host (interactive retry loop)

# ── SSH key & SSHFS host prerequisites ──
SSH_KEY_PATH=""
SSH_PUB_KEY=""
AGENTEAM_CFG="$AGENTEAM_DIR/agenteam.json"
SSH_FIRST_SETUP=false

# Read sshKeyPath from agenteam.json via env var (avoids path injection in JS string literals)
if [ -f "$AGENTEAM_CFG" ]; then
  SSH_KEY_PATH=$(AGENTEAM_CFG="$AGENTEAM_CFG" AGENTEAM_DIR="$AGENTEAM_DIR" node -e "
    try {
      const path = require('path');
      const c = JSON.parse(require('fs').readFileSync(process.env.AGENTEAM_CFG,'utf-8'));
      const p = (c.sandbox && c.sandbox.sshKeyPath) || '';
      process.stdout.write(path.isAbsolute(p) ? p : path.join(process.env.AGENTEAM_DIR, p));
    } catch { process.stdout.write(''); }
  " 2>/dev/null || true)
fi

# Auto-generate key if none configured
if [ -z "$SSH_KEY_PATH" ]; then
  SSH_KEY_PATH="$AGENTEAM_DIR/sandbox_key"
  if [ ! -f "$SSH_KEY_PATH" ]; then
    SSH_FIRST_SETUP=true
    mkdir -p "$AGENTEAM_DIR"
    ssh-keygen -t ed25519 -f "$SSH_KEY_PATH" -N "" -C "agenteam-sandbox" -q
    ok "SSH key generated at $SSH_KEY_PATH"
    # Write sshKeyPath into agenteam.json using relative path (relative to ~/.agenteam/)
    SSH_KEY_RELATIVE="./sandbox_key"
    AGENTEAM_CFG="$AGENTEAM_CFG" SSH_KEY_RELATIVE="$SSH_KEY_RELATIVE" node -e "
      const fs = require('fs');
      const p = process.env.AGENTEAM_CFG;
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
      if (!cfg.sandbox) cfg.sandbox = {};
      cfg.sandbox.sshKeyPath = process.env.SSH_KEY_RELATIVE;
      fs.mkdirSync(require('path').dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
    " 2>/dev/null
    ok "sshKeyPath written to $AGENTEAM_CFG"
    echo ""
    warn "Add this public key to your Git repository's SSH keys:"
    echo ""
    cat "${SSH_KEY_PATH}.pub"
    echo ""
    warn "  GitHub:  https://github.com/settings/keys"
    warn "  GitLab:  https://gitlab.com/-/user_settings/ssh_keys"
    warn "  Gitee:   https://gitee.com/profile/sshkeys"
    echo ""
  fi
fi

# Validate key files exist
if [ ! -f "$SSH_KEY_PATH" ]; then
  fail "SSH private key not found: $SSH_KEY_PATH (configured in $AGENTEAM_CFG)"
fi
SSH_PUB_KEY="${SSH_KEY_PATH}.pub"
if [ ! -f "$SSH_PUB_KEY" ]; then
  warn "SSH public key not found: $SSH_PUB_KEY — authorized_keys check skipped"
  SSH_PUB_KEY=""
fi
ok "SSH key: $SSH_KEY_PATH"

# Resolve sshd port: agenteam.json sandbox.sshPort → detected → 22; persist if detected.
SSHD_PORT=$(AGENTEAM_CFG="$AGENTEAM_CFG" node -e "
  try { const c=JSON.parse(require('fs').readFileSync(process.env.AGENTEAM_CFG,'utf-8'));
        if (c.sandbox && c.sandbox.sshPort) process.stdout.write(String(c.sandbox.sshPort)); } catch {}" 2>/dev/null)
if [ -z "$SSHD_PORT" ]; then
  SSHD_PORT=$(detect_sshd_port)
  AGENTEAM_CFG="$AGENTEAM_CFG" SSHD_PORT="$SSHD_PORT" node -e "
    const fs=require('fs'),path=require('path'),p=process.env.AGENTEAM_CFG;
    let c={}; try{c=JSON.parse(fs.readFileSync(p,'utf-8'))}catch{}
    (c.sandbox=c.sandbox||{}).sshPort=Number(process.env.SSHD_PORT);
    fs.mkdirSync(path.dirname(p),{recursive:true});
    fs.writeFileSync(p,JSON.stringify(c,null,2)+'\n');" 2>/dev/null
fi
ok "sshd port: $SSHD_PORT"

# Ensure SSH server is installed and running (needed for container SSHFS + Git over SSH to host)
if [ "$(uname -s)" = "Darwin" ]; then
  # macOS: sshd is built-in but disabled by default; try non-GUI activation first
  if port_listening "$SSHD_PORT"; then
    ok "SSH server listening on port $SSHD_PORT"
  else
    warn "SSH server is NOT running — attempting to enable Remote Login..."
    MACOS_SSH_ENABLED=false

    # Method 1: systemsetup (works on most macOS versions, needs sudo)
    if ! $MACOS_SSH_ENABLED && command -v systemsetup >/dev/null 2>&1; then
      if sudo -n systemsetup -setremotelogin on 2>/dev/null; then
        MACOS_SSH_ENABLED=true
        ok "Remote Login enabled via systemsetup"
      fi
    fi

    # Method 2: launchctl bootstrap (modern macOS, fallback)
    if ! $MACOS_SSH_ENABLED; then
      if sudo -n launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist 2>/dev/null \
         || sudo -n launchctl enable system/com.openssh.sshd 2>/dev/null; then
        sudo -n launchctl kickstart -k system/com.openssh.sshd 2>/dev/null || true
        MACOS_SSH_ENABLED=true
        ok "Remote Login enabled via launchctl"
      fi
    fi

    # Method 3: legacy launchctl load (older macOS)
    if ! $MACOS_SSH_ENABLED; then
      if sudo -n launchctl load -w /System/Library/LaunchDaemons/ssh.plist 2>/dev/null; then
        MACOS_SSH_ENABLED=true
        ok "Remote Login enabled via launchctl load"
      fi
    fi

    if $MACOS_SSH_ENABLED; then
      sleep 1
      if port_listening "$SSHD_PORT"; then
        ok "SSH server listening on port $SSHD_PORT"
      else
        warn "Remote Login enabled but port $SSHD_PORT not yet listening — may need a moment"
      fi
    else
      warn "Could not auto-enable SSH — sudo may require a password"
      warn "  Option 1: Run with password:  sudo systemsetup -setremotelogin on"
      warn "  Option 2: GUI:  System Settings → General → Sharing → Remote Login"
    fi
  fi
else
  # Linux: install openssh-server if missing, then start + enable
  if ! command -v sshd >/dev/null 2>&1 && ! [ -x /usr/sbin/sshd ]; then
    warn "openssh-server not installed — installing..."
    pkg_install openssh-server \
      || fail "Failed to install openssh-server. Run manually: sudo apt install openssh-server"
  fi
  if ! port_listening "$SSHD_PORT"; then
    SSH_SVC=$(detect_ssh_service)
    warn "SSH server not listening on port $SSHD_PORT — starting $SSH_SVC..."
    sudo systemctl start "$SSH_SVC" \
      || warn "Failed to start $SSH_SVC. Run manually: sudo systemctl start $SSH_SVC"
    sudo systemctl enable "$SSH_SVC" 2>&1 || true
  fi
  if port_listening "$SSHD_PORT"; then
    ok "SSH server listening on port $SSHD_PORT"
  else
    warn "SSH server still not listening on port $SSHD_PORT — container SSHFS mounts will fail"
  fi
fi

# Auto-add public key to ~/.ssh/authorized_keys (idempotent)
if [ -n "$SSH_PUB_KEY" ]; then
  AUTH_KEYS="$HOME/.ssh/authorized_keys"
  if [ -f "$AUTH_KEYS" ] && grep -qF "$(cat "$SSH_PUB_KEY")" "$AUTH_KEYS" 2>/dev/null; then
    ok "SSH public key in authorized_keys"
  else
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    cat "$SSH_PUB_KEY" >> "$AUTH_KEYS"
    chmod 600 "$AUTH_KEYS"
    ok "SSH public key added to $AUTH_KEYS"
  fi
fi

# Firewall hint only on first setup
if [ "$SSH_FIRST_SETUP" = true ]; then
  warn "Ensure host firewall allows Docker network → port $SSHD_PORT (for container SSHFS mounts)"
fi

# ── SSH connectivity to git host ──
# Override with: export GIT_TEST_HOST=git.example.com
GIT_TEST_HOST="${GIT_TEST_HOST:-github.com}"
echo ""
echo "Testing SSH connectivity to $GIT_TEST_HOST..."
test_git_ssh() {
  local output
  output=$(ssh -T -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes -i "$SSH_KEY_PATH" "git@$GIT_TEST_HOST" 2>&1 || true)
  echo "$output" | grep -qiE "welcome|successfully authenticated|You've successfully|GitLab|GitHub"
}

if test_git_ssh; then
  ok "$GIT_TEST_HOST SSH connectivity verified"
elif [ ! -t 0 ]; then
  warn "$GIT_TEST_HOST SSH connectivity failed (non-interactive — skipping retry)"
else
  # Interactive SSH setup loop
  while true; do
    echo ""
    warn "$GIT_TEST_HOST SSH connectivity failed"
    echo ""
    echo "  Your public key:"
    echo "  $(cat "${SSH_KEY_PATH}.pub")"
    echo ""
    echo "  Add it on your git host's SSH keys settings page"
    echo "  (e.g. ${GREEN}https://github.com/settings/keys${NC} for GitHub)."
    echo ""
    printf "  Press ${GREEN}Enter${NC} to re-test, or enter a ${YELLOW}number${NC} to skip: "
    read -r user_input
    if [[ "$user_input" =~ ^[0-9]+$ ]]; then
      warn "SSH test skipped — container Git operations may fail"
      break
    fi
    if test_git_ssh; then
      ok "$GIT_TEST_HOST SSH connectivity verified"
      break
    fi
  done
fi
