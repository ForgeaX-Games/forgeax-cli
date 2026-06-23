# shellcheck shell=bash
# Container runtime: Docker Engine (with Podman/podman-docker auto-replacement on Linux,
# OrbStack on macOS), daemon startup (systemd or bare dockerd), and Linux kernel
# tuning (unprivileged_userns_clone, apparmor_restrict_unprivileged_userns).

# Helper: poll until `docker info` succeeds (arg1 = max seconds, default 60)
wait_for_docker() {
  local max_wait="${1:-60}"
  local interval=2
  local elapsed=0
  info "Waiting for Docker daemon to become ready (up to ${max_wait}s)..."
  while [ "$elapsed" -lt "$max_wait" ]; do
    command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && return 0
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
  return 1
}

# Helper: detect Podman masquerading as Docker (podman-docker compatibility layer)
is_podman_docker() {
  if command -v podman >/dev/null 2>&1; then
    # podman-docker installs a `docker` shim that delegates to podman
    local docker_path
    docker_path=$(command -v docker 2>/dev/null)
    if [ -n "$docker_path" ]; then
      # Check if docker binary is a symlink/wrapper to podman
      if readlink -f "$docker_path" 2>/dev/null | grep -q podman; then
        return 0
      fi
      # Check docker version output for podman signature
      if docker --version 2>/dev/null | grep -qi podman; then
        return 0
      fi
      # Check docker info for podman
      if docker info 2>/dev/null | grep -qi podman; then
        return 0
      fi
    fi
  fi
  return 1
}

# Install Docker on Linux (apt/dnf/yum)
install_docker_linux() {
  info "Attempting to install Docker Engine..."
  if command -v apt >/dev/null 2>&1; then
    # Debian/Ubuntu — use official convenience script
    if curl -fsSL https://get.docker.com | sudo sh; then
      return 0
    fi
    # Fallback to distro package
    sudo apt install -y docker.io && return 0
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y docker && return 0
  elif command -v yum >/dev/null 2>&1; then
    sudo yum install -y docker && return 0
  fi
  return 1
}

if command -v docker >/dev/null 2>&1; then
  # Detect Podman pretending to be Docker — auto-replace with genuine Docker Engine
  if is_podman_docker; then
    echo ""
    warn "Detected Podman Docker-compatibility layer (podman-docker)"
    warn "AgenTeam requires genuine Docker Engine — replacing automatically..."
    echo ""
    if [ "$(uname -s)" = "Linux" ]; then
      # Remove podman-docker
      if command -v dnf >/dev/null 2>&1; then
        sudo dnf remove -y podman-docker 2>&1 | tail -3 || true
      elif command -v yum >/dev/null 2>&1; then
        sudo yum remove -y podman-docker 2>&1 | tail -3 || true
      elif command -v apt-get >/dev/null 2>&1; then
        sudo apt-get remove -y podman-docker 2>&1 | tail -3 || true
      fi
      ok "podman-docker removed"
      # Install genuine Docker Engine
      if install_docker_linux; then
        ok "Docker Engine installed"
        if command -v systemctl >/dev/null 2>&1 && [ "$(cat /proc/1/comm 2>/dev/null)" = "systemd" ]; then
          sudo systemctl start docker 2>/dev/null || true
          sudo systemctl enable docker 2>/dev/null || true
        else
          dockerd >/var/log/dockerd.log 2>&1 &
          disown "$!" 2>/dev/null || true
        fi
        if ! groups | grep -q docker; then
          sudo usermod -aG docker "$(whoami)" 2>/dev/null || true
          warn "Added $(whoami) to docker group — may need re-login for group to take effect"
        fi
        wait_for_docker 30
      else
        fail "Failed to install Docker Engine after removing podman-docker. Install manually: curl -fsSL https://get.docker.com | sudo sh"
      fi
    elif [ "$(uname -s)" = "Darwin" ]; then
      warn "macOS: Podman is not supported. Please install one of:"
      warn "  OrbStack (recommended): https://orbstack.dev"
      warn "  Docker Desktop: https://docker.com/products/docker-desktop"
      fail "Please install a supported Docker runtime and re-run this script."
    fi
  fi

  if ! docker info >/dev/null 2>&1; then
    if [ "$(uname -s)" = "Darwin" ]; then
      if command -v orb >/dev/null 2>&1; then
        warn "Docker daemon is not running — starting OrbStack..."
        orb start 2>/dev/null || true
      elif [ -d "/Applications/OrbStack.app" ]; then
        warn "Docker daemon is not running — launching OrbStack.app..."
        open -a OrbStack
      elif [ -d "/Applications/Docker.app" ]; then
        warn "Docker daemon is not running — launching Docker Desktop..."
        open -a Docker
      else
        warn "Docker daemon is not running — no known Docker runtime found"
      fi
      wait_for_docker 60
    else
      # Check if systemd is available (PID 1)
      if command -v systemctl >/dev/null 2>&1 && [ "$(cat /proc/1/comm 2>/dev/null)" = "systemd" ]; then
        warn "Docker daemon is not running — starting via systemd..."
        sudo systemctl start docker \
          || warn "Failed to start Docker. Run: sudo systemctl start docker"
        sudo systemctl enable docker 2>&1 || true
      else
        warn "Docker daemon is not running (non-systemd environment) — starting dockerd manually..."
        dockerd >/var/log/dockerd.log 2>&1 &
        DOCKERD_PID=$!
        disown "$DOCKERD_PID" 2>/dev/null || true
        info "dockerd started (pid $DOCKERD_PID, log: /var/log/dockerd.log)"
      fi
    fi
  fi
  if docker info >/dev/null 2>&1; then
    ok "docker $(docker --version | head -c 40)"
  else
    warn "Docker daemon still not running — container features will fail"
  fi

  # ── Linux kernel tuning for containers (needs sudo) ──
  if [ "$(uname -s)" = "Linux" ]; then
    echo "Checking kernel settings (may prompt for sudo password)..."
    USERNS_PATH="/proc/sys/kernel/unprivileged_userns_clone"
    if [ -f "$USERNS_PATH" ]; then
      if [ "$(cat "$USERNS_PATH")" != "1" ]; then
        warn "kernel.unprivileged_userns_clone=0 — enabling (needed for container sandboxing)..."
        sudo sysctl -w kernel.unprivileged_userns_clone=1 >/dev/null 2>&1 \
          || warn "failed to set unprivileged_userns_clone — some apps (Steam, Chrome) may not work in containers"
        ok "kernel.unprivileged_userns_clone=1"
      else
        ok "kernel.unprivileged_userns_clone=1"
      fi
    fi

    APPARMOR_USERNS="/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
    if [ -f "$APPARMOR_USERNS" ] && [ "$(cat "$APPARMOR_USERNS")" != "0" ]; then
      warn "apparmor_restrict_unprivileged_userns=1 — disabling for container compatibility..."
      sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 \
        || warn "failed to disable apparmor userns restriction"
      ok "apparmor_restrict_unprivileged_userns=0"
    fi
  fi
elif [ "$(uname -s)" = "Darwin" ]; then
  warn "docker not found — OrbStack is recommended for macOS containers"
  if command -v brew >/dev/null 2>&1; then
    info "Installing OrbStack via Homebrew (this may take a few minutes)..."
    if brew install orbstack 2>&1 | tail -5; then
      ok "OrbStack installed"
      info "Launching OrbStack for first-time setup — please follow the on-screen prompts..."
      open -a OrbStack 2>/dev/null || orb start 2>/dev/null || true
      wait_for_docker 120
      if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        ok "docker $(docker --version | head -c 40)"
      else
        warn "OrbStack installed but Docker not ready yet — please complete setup in the OrbStack window"
      fi
    else
      fail "OrbStack installation failed — install manually: https://orbstack.dev"
    fi
  else
    warn "Homebrew not found — install OrbStack manually: https://orbstack.dev"
    warn "  Or install Homebrew first:"
    warn "    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
  fi
else
  # Linux: Docker not found — attempt auto-install
  warn "docker not found — installing Docker Engine..."
  if install_docker_linux; then
    ok "Docker Engine installed"
    sudo systemctl start docker 2>/dev/null || true
    sudo systemctl enable docker 2>/dev/null || true
    # Add current user to docker group to avoid sudo requirement
    if ! groups | grep -q docker; then
      sudo usermod -aG docker "$(whoami)" 2>/dev/null || true
      warn "Added $(whoami) to docker group — you may need to log out and back in for group change to take effect"
    fi
    wait_for_docker 30
    if docker info >/dev/null 2>&1; then
      ok "docker $(docker --version | head -c 40)"
    else
      warn "Docker installed but daemon not ready — try: sudo systemctl start docker"
    fi
  else
    fail "Docker installation failed. Install manually: curl -fsSL https://get.docker.com | sudo sh"
  fi
fi
