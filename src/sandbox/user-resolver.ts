// @desc Resolve container user identity for docker exec

/**
 * Shared SSH key directory inside the container.
 *
 * Path aligned with the container's passwd home (`/home/you`) following
 * Unix dotfile convention, so OpenSSH's getpwuid-based `~/.ssh/` discovery lands
 * here directly — no symlinks, no IdentityFile gymnastics for tools that ignore
 * `$HOME` env.
 *
 * Layout: `sandbox_key` (or user-configured key file) is copied into this
 * directory via `docker cp` on each container start (see `_setupSharedSshHome`).
 * The directory itself is container-fs (writable), so SSH can write
 * `known_hosts` and a default `config` can be placed alongside.
 *
 * Used by: _setupSharedSshHome, _configureGitInContainer, mount-sshfs.sh
 */
export const SSH_KEY_DIR = "/home/you/.ssh";

const HOST_UID = process.getuid?.() ?? 0;
const HOST_GID = process.getgid?.() ?? 0;
const HOST_USER = HOST_UID === 0 ? "root" : `${HOST_UID}:${HOST_GID}`;

/**
 * Resolve the docker exec user identity.
 *
 * The instance dir is bind-mounted into the container, so file ownership is
 * shared with the host. Default to host uid:gid so agent/plugin commands
 * don't leave root-owned files on the host.
 *
 * @param privileged  false (default caller semantics) → host uid:gid —
 *                           agent shell, workspace fs, execSync from agent
 *                           code / plugins, anything touching the bind mount.
 *                    true  → root — only for system init that must write
 *                           `/etc` / container-internal paths (SandboxManager
 *                           `_configureGitInContainer`, `_mountSshfs`, host
 *                           UID mapping, …). Callers must opt in explicitly.
 */
export function resolveContainerUser(privileged: boolean): string {
  return privileged ? "root" : HOST_USER;
}
