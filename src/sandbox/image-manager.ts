// @desc Docker image lifecycle for sandbox: drift detection + ensure-exists + rebuild
import { join } from "node:path";
import { runDocker } from "./docker-cli.js";
import { buildPackDocker, isPackBuilt } from "../packs/pack-builder.js";
import { getSharedPaths } from "../fs/state-dir.js";
import { getPathManager } from "../fs/path-manager.js";
import type { SandboxMode } from "../defaults/pack/pack-json.js";
import type { ProvisioningPhase } from "../core/types.js";

/**
 * Detect whether a container's bound image sha256 differs from the current
 * tag's sha256 — i.e., pack changed or image was rebuilt after the container
 * was created. Docker writes the image sha256 (not tag) into containerConfig
 * at creation, and `docker start` always uses that sha256, so tag reassignment
 * alone doesn't rebind the container.
 *
 * Returns:
 *   - true  : drift detected (container needs rm + re-run)
 *             - bound sha != tag sha, OR
 *             - tag doesn't exist (pack was clean-image'd; ensureImageExists
 *               will rebuild it later)
 *   - false : consistent, or unable to inspect (conservative: skip rm)
 */
export async function imageDrifted(name: string, resolvedImage: string): Promise<boolean> {
  let boundId: string;
  try {
    boundId = (await runDocker(["inspect", "--format", "{{.Image}}", name])).trim();
  } catch {
    return false; // container not inspectable, let caller handle
  }
  if (!boundId) return false;

  try {
    const tagId = (await runDocker(["image", "inspect", "--format", "{{.Id}}", resolvedImage])).trim();
    return tagId !== "" && tagId !== boundId;
  } catch {
    // Tag missing (clean-image'd) → treat as drift; ensureImageExists rebuilds.
    return true;
  }
}

/**
 * Ensure `resolvedImage` is present in local Docker. Three-level resolution
 * (delegated to isPackBuilt in pack-builder.ts):
 *   1. Image already in daemon → no-op
 *   2. Not in daemon but packs/{packId}/image.tar exists → docker load
 *   3. Neither → rebuild via buildPackDocker
 *
 * Throws if packId is missing — the caller must have a valid manifest.id
 * before reaching this point.
 */
export async function ensureImageExists(
  packId: string | undefined,
  resolvedImage: string,
  mode: SandboxMode,
  onStatus?: (message: string, phase?: ProvisioningPhase) => void,
): Promise<void> {
  if (!packId) {
    throw new Error(
      `[ImageManager] Cannot ensure image ${resolvedImage}: packId not found in manifest`,
    );
  }
  const packDir = join(getSharedPaths().packsDir(), packId);
  if (await isPackBuilt(packDir, packId, true)) return;

  console.warn(
    `[ImageManager] Image ${resolvedImage} not found locally — rebuilding...`,
  );
  onStatus?.("Rebuilding Docker image (this may take a few minutes)...", "rebuilding_image");
  await rebuildImage(packId, mode);
}

/**
 * Force a pack rebuild: buildPackDocker merges the built-in Dockerfile
 * (headless/desktop) with pack-level additions and executes docker build,
 * producing the final `mc-sbx-pack-{packId}:latest` tag plus image.tar.
 */
async function rebuildImage(packId: string, mode: SandboxMode): Promise<void> {
  const packDir = join(getSharedPaths().packsDir(), packId);
  const instanceRoot = getPathManager().instance().root();
  await buildPackDocker(packDir, packId, instanceRoot, mode);
}
