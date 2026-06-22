// @desc Idempotent per-run container self-heal: KEX/FUSE/umask/passwd/sudoers/SSH/git/SSHFS
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { userInfo } from "node:os";
import { runDocker } from "./docker-cli.js";
import { getPathManager } from "../fs/path-manager.js";
import { resolveContainerUser, SSH_KEY_DIR } from "./user-resolver.js";
import type { SandboxConfig } from "./manager.js";

/**
 * Apply the full container-build-layer setup after a container is known to be
 * running. Called from SandboxManager._doEnsureSandbox in all three branches
 * (running / started-from-exited / freshly-run) — the operations are naturally
 * idempotent so the repeated invocation is safe.
 *
 * Sequence:
 *   1. System config — KEX compat / FUSE / umask / passwd / sudoers
 *   2. SSH keys      — docker cp key to /home/you/.ssh + Host config
 *   3. Git config    — identity / safe.directory / core.sshCommand
 *   4. SSHFS mount   — exec mount-sshfs.sh for dynamic mounts.json
 */
export async function applyContainerSetup(
  name: string,
  config: SandboxConfig & { packId?: string },
): Promise<void> {
  await configureContainerSystem(name);
  await setupSharedSshHome(name, config.sshKeyPath);
  await configureGitInContainer(name, config.sshKeyPath, config.packId);
  await mountSshfs(name, config.mode, config.sshPort);
}

/**
 * Step 1-5: per-container-run system config.
 * All ops idempotent (grep-before-append / sed natural-idempotence / atomic
 * sed rewrite for passwd). Old images without `/etc/sudoers.d/` still work via
 * `mkdir -p` guard — the entry writes but takes effect only after sudo package
 * install (next image rebuild).
 *
 * Inventory:
 *   1. SSH KEX compat        — /etc/ssh/ssh_config.d/50-kex-compat.conf
 *   2. FUSE user_allow_other — sed /etc/fuse.conf
 *   3. umask 022             — append to bashrc variants
 *   4. Host UID mapping      — /etc/passwd + /etc/group entries, passwd
 *                              field '*' so PAM skips shadow lookup
 *   5. Passwordless sudo     — /etc/sudoers.d/agenteam-{uid}
 */
async function configureContainerSystem(name: string): Promise<void> {
  // 1. SSH KEX compatibility (macOS sshd LibreSSL post-quantum KEX workaround)
  try {
    await runDocker(["exec", name, "sh", "-c",
      "mkdir -p /etc/ssh/ssh_config.d && printf 'Host host.docker.internal\\n  KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521\\n' > /etc/ssh/ssh_config.d/50-kex-compat.conf",
    ]);
  } catch (e) {
    console.warn("[ContainerSetup] SSH KEX compat config failed (non-fatal):", e);
  }

  // 2. FUSE: enable user_allow_other for SSHFS mounts (sed idempotent — pattern
  //    only matches the commented form)
  try {
    await runDocker(["exec", name, "sed", "-i", "s/#user_allow_other/user_allow_other/", "/etc/fuse.conf"]);
  } catch (e) {
    console.warn("[ContainerSetup] FUSE user_allow_other config failed (non-fatal):", e);
  }

  // 3. umask 022 — idempotent append (grep check before writing)
  for (const file of ["/etc/bash.bashrc", "/root/.bashrc", "/home/you/.bashrc"]) {
    try {
      await runDocker(["exec", name, "sh", "-c",
        `grep -q "umask 022" ${file} 2>/dev/null || echo "umask 022" >> ${file}`,
      ]);
    } catch (e) {
      console.warn(`[ContainerSetup] umask config for ${file} failed (non-fatal):`, e);
    }
  }

  // 4. Host UID mapping — resolveContainerUser(false) exec's as host uid:gid,
  //    so passwd/group entries are needed or whoami/$USER/$HOME break.
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  if (uid !== 0) {
    const uname = userInfo().username || `host${uid}`;
    // Home: /home/you — container-fs writable directory aligned with
    //   SSH_KEY_DIR so OpenSSH's getpwuid-based ~/.ssh/ discovery finds
    //   the docker-cp'd key without symlinks.
    // Password field: '*' (not 'x') — 'x' defers to /etc/shadow, but we
    //   don't create a shadow entry for this mapped uid. Without a shadow
    //   entry, PAM's account module rejects the user with "account
    //   validation failure", breaking sudo even when sudoers has NOPASSWD.
    //   '*' means "no local password" and PAM skips the shadow lookup,
    //   so NOPASSWD sudoers becomes the sole auth gate.
    try {
      // Create entry if missing, OR self-heal existing entry whose password
      // field is still 'x' (legacy) or whose home is stale. One sed rewrites
      // both columns atomically for our uid.
      await runDocker(["exec", name, "sh", "-c",
        `if ! getent passwd ${uid} >/dev/null; then ` +
        `  echo "${uname}:*:${uid}:${gid}:host-user:/home/you:/bin/bash" >> /etc/passwd; ` +
        `else ` +
        `  sed -i -E "s|^([^:]+):[^:]*:${uid}:([^:]*):([^:]*):[^:]*:(.*)$|\\\\1:*:${uid}:\\\\2:\\\\3:/home/you:\\\\4|" /etc/passwd; ` +
        `fi`,
      ]);
      await runDocker(["exec", name, "sh", "-c",
        `getent group ${gid} >/dev/null || echo "${uname}:x:${gid}:" >> /etc/group`,
      ]);
    } catch (e) {
      console.warn("[ContainerSetup] host UID mapping failed (non-fatal):", e);
    }

    // 5. Passwordless sudo for the mapped host user. File write is naturally
    //    idempotent (always rewrites same content). `mkdir -p` handles legacy
    //    images where /etc/sudoers.d/ is absent (sudo package not installed).
    //    Both headless and desktop Dockerfiles install sudo; on legacy images
    //    the entry still writes but takes effect only after image rebuild.
    try {
      const sudoersPath = `/etc/sudoers.d/agenteam-${uid}`;
      await runDocker(["exec", name, "sh", "-c",
        `mkdir -p /etc/sudoers.d && echo "${uname} ALL=(ALL) NOPASSWD: ALL" > ${sudoersPath} && chmod 0440 ${sudoersPath}`,
      ]);
    } catch (e) {
      console.warn("[ContainerSetup] sudoers entry failed (non-fatal):", e);
    }
  }
}

/**
 * Place SSH assets into the container's passwd home (`/home/you`) so
 * that `ssh`/`git` via getpwuid find the key at `~/.ssh/`. Idempotent.
 * `docker cp` (not bind mount) lets SSH_KEY_DIR change without rebuilding.
 */
async function setupSharedSshHome(name: string, sshKeyPath: string | undefined): Promise<void> {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  const keyPath = sshKeyPath || undefined;
  const hasKey = keyPath && existsSync(keyPath);

  try {
    await runDocker(["exec", name, "sh", "-c",
      `mkdir -p /home/you ${SSH_KEY_DIR} && chmod 755 /home/you ${SSH_KEY_DIR}`]);

    if (hasKey) {
      const keyName = basename(keyPath);
      const configPath = `${SSH_KEY_DIR}/config`;
      const configBody =
        "# Auto-generated by AgenTeam SandboxManager — edit freely, not regenerated once present.\n" +
        `Host *\n    IdentityFile ${SSH_KEY_DIR}/${keyName}\n    IdentitiesOnly yes\n`;
      await runDocker(["cp", keyPath, `${name}:${SSH_KEY_DIR}/${keyName}`]);
      await runDocker(["exec", name, "sh", "-c",
        `chmod 600 ${SSH_KEY_DIR}/${keyName}; ` +
        `[ -e ${configPath} ] || { printf '%s' "$1" > ${configPath} && chmod 644 ${configPath}; }`,
        "sh", configBody,
      ]);
    }

    if (uid !== 0) {
      await runDocker(["exec", name, "chown", "-R", `${uid}:${gid}`, "/home/you"]);
    }

    // Populate /etc/ssh/ssh_known_hosts for the instance's git remote
    // (idempotent: grep skips already-known hosts, HTTPS remotes no-op).
    const root = getPathManager().instance().root();
    await runDocker(["exec", name, "sh", "-c",
      `host=$(git -C "${root}" remote get-url origin 2>/dev/null | sed -n 's/.*@\\([^:/]*\\)[:/].*/\\1/p'); ` +
      `[ -n "$host" ] && ! grep -q "^$host " /etc/ssh/ssh_known_hosts 2>/dev/null && ` +
      `ssh-keyscan -T 5 "$host" >> /etc/ssh/ssh_known_hosts 2>/dev/null; true`]);
  } catch (e) {
    console.warn("[ContainerSetup] shared ssh home setup failed (non-fatal):", e);
  }
}

/**
 * Configure git identity, safe.directory and SSH inside the container.
 * Runs once per container start — idempotent.
 *
 * All config uses --system (writes /etc/gitconfig) so it's globally visible.
 * Identity follows the same format as host-side ensureGitIdentity() in
 * instance-provision.ts (using packId from manifest.json). SSH keys are
 * placed at SSH_KEY_DIR via `docker cp` in `setupSharedSshHome` (which runs
 * before this function).
 */
async function configureGitInContainer(
  name: string,
  sshKeyPath: string | undefined,
  packId: string | undefined,
): Promise<void> {
  const root = getPathManager().instance().root();
  const user = resolveContainerUser(true);

  // git identity — shared by all agents in this instance
  const gitName = `instance/${packId ?? "unknown"}`;
  const gitEmail = `${packId ?? "unknown"}@agenteam.local`;
  try {
    await runDocker(["exec", "--user", user, name, "git", "config", "--system", "user.name", gitName]);
    await runDocker(["exec", "--user", user, name, "git", "config", "--system", "user.email", gitEmail]);
  } catch (e) {
    console.warn("[ContainerSetup] git identity config failed (non-fatal):", e);
  }

  // safe.directory: container exec user may differ from host file owner
  try {
    await runDocker([
      "exec", "--user", user, name,
      "git", "config", "--system", "--add", "safe.directory", root,
    ]);
  } catch { /* git may not be installed — non-fatal */ }

  if (sshKeyPath) {
    const keyName = basename(sshKeyPath);
    const sshCmd = `ssh -i ${SSH_KEY_DIR}/${keyName} -o StrictHostKeyChecking=accept-new`;
    try {
      await runDocker([
        "exec", "--user", user, name,
        "git", "config", "--system", "core.sshCommand", sshCmd,
      ]);
    } catch { /* non-fatal */ }
  }
  // Note: known_hosts pre-population lives in setupSharedSshHome —
  // it's an SSH-auth concern, not git-specific.
}

/**
 * Execute mount-sshfs script inside the container to mount SSHFS directories.
 * The script is accessed via volume mount (instance root is mounted rw), not
 * COPY'd into image. Path: {instanceRoot}/docker/{mode}/mount-sshfs.sh.
 * Non-fatal: mount failures are logged but don't prevent container startup.
 */
/**
 * Also exported standalone so `manager.init()`'s mounts.json FSWatcher can
 * re-mount SSHFS precisely without rerunning the full setup chain.
 */
export async function mountSshfs(
  name: string,
  mode: "headless" | "desktop" | "direct",
  sshPort: number | undefined,
): Promise<void> {
  const mountsJson = getPathManager().instance().mountsConfig();
  if (!existsSync(mountsJson)) return;

  // isEnabled() filters out "direct" before ensureSandbox is called, so
  // mode here is always "headless" | "desktop" in practice.
  if (mode === "direct") return;

  const root = getPathManager().instance().root();
  const scriptPath = join(root, "docker", mode, "mount-sshfs.sh");

  try {
    // Ensure script is executable (volume mount may not preserve +x)
    await runDocker(["exec", name, "chmod", "+x", scriptPath]);
    await runDocker([
      "exec", "--user", "root", name,
      "bash", scriptPath,
      "--ssh-user", userInfo().username,
      "--ssh-port", String(sshPort),
      "--mounts-json", mountsJson,
    ]);
  } catch (e) {
    console.warn(`[ContainerSetup] SSHFS mount script failed (non-fatal):`, e);
  }
}
