#!/usr/bin/env bash
# AgenTeam-OS startup — sources modular phases under scripts/start/ in numeric order.
# Each phase sets globals / defines functions used by later phases (single shell, sourced).
#
#   scripts/start/00-common.sh    helpers, AGENTEAM_DIR, git pull, ownership repair, utils
#   scripts/start/10-runtime.sh   git, node (auto-discover + nvm fallback), pnpm, C++, pnpm install
#   scripts/start/20-docker.sh    docker / podman → docker / OrbStack + kernel sysctl tuning
#   scripts/start/30-sys-deps.sh  rsync, zip/unzip, socat
#   scripts/start/40-ssh.sh       sandbox key, sshd, authorized_keys, git host connectivity test
#   scripts/start/50-workspace.sh packs dir, gateway port shutdown, UI build
#   scripts/start/60-config.sh    default model, LLM key validation, tool keys
#   scripts/start/70-launch.sh    exec pnpm start "$@"
#
# To skip a phase temporarily: comment / rename its file (lexical order matters).
set -euo pipefail
cd "$(dirname "$0")"

[ -d scripts/start ] || { printf '\033[0;31m✗\033[0m scripts/start/ missing — broken install?\n'; exit 1; }

for _phase in scripts/start/*.sh; do
  # shellcheck source=/dev/null
  . "$_phase"
done
