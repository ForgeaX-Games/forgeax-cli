/**
 * Container recovery — unified diagnosis + trigger for container-unavailable errors.
 *
 * Used by fs-bridge (withContainerRecovery wrapper), terminal/manager (shell failures),
 * and any tool that talks to the Docker sandbox.
 */

import type { ProvisioningPhase } from "../core/types.js";
import { getSandboxManager } from "./manager.js";

// ─── Types ───

export type RecoveryKind = "container" | "image" | "unknown";

/**
 * Optional status callback registered by the instance worker so that
 * container recovery progress is reported back to the gateway via IPC.
 */
let _onRecoveryStatus: ((message: string, phase?: ProvisioningPhase) => void) | null = null;
let _onRecoveryDone: ((error?: string) => void) | null = null;

export function setRecoveryCallbacks(
  onStatus: (message: string, phase?: ProvisioningPhase) => void,
  onDone: (error?: string) => void,
): void {
  _onRecoveryStatus = onStatus;
  _onRecoveryDone = onDone;
}

// ─── Detection ───

export function isContainerUnavailable(err: any): boolean {
  return err?.code === "ENOENT" || /No such container|not running/i.test(err?.message ?? "");
}

export async function probeRecoveryKind(): Promise<RecoveryKind> {
  const mgr = getSandboxManager();
  if (!mgr) return "unknown";
  const imageOk = await mgr.isImageAvailable();
  return imageOk ? "container" : "image";
}

// ─── Diagnostic message ───

export function buildContainerDiagnostic(
  label: string,
  err: Error,
  recoveryKind: RecoveryKind = "unknown",
): string {
  const lines = [
    "",
    `[${label} failed: container unavailable]`,
    `error: ${err.message}`,
    "",
  ];
  if (recoveryKind === "image") {
    lines.push(
      "[sandbox recovery] The Docker image is missing and is being rebuilt.",
      "This may take several minutes. Please wait and retry your command.",
    );
  } else if (recoveryKind === "container") {
    lines.push(
      "[sandbox recovery] The Docker container has been removed or stopped and is being restarted.",
      "Please wait a few seconds and retry your command.",
    );
  } else {
    lines.push(
      "[sandbox recovery] The Docker container may have been removed or stopped.",
      "The system is automatically rebuilding. Please wait a moment and retry your command.",
    );
  }
  return lines.join("\n");
}

// ─── Recovery trigger ───

/**
 * Fire-and-forget container recovery. Safe under concurrent calls
 * (SandboxManager.ensureSandbox deduplicates via _startingPromise).
 */
export function triggerRecovery(label: string): void {
  const sandbox = getSandboxManager();
  if (!sandbox?.isEnabled()) return;
  console.warn(`[container-recovery] Container lost (trigger: ${label}), rebuilding...`);
  sandbox.invalidateAndRestart(_onRecoveryStatus ?? undefined)
    .then(() => { _onRecoveryDone?.(); })
    .catch((err) => {
      _onRecoveryDone?.(err instanceof Error ? err.message : String(err));
      console.error(`[container-recovery] Recovery failed (${label}):`, err);
    });
}

// ─── High-level wrapper ───

/**
 * Detect container-unavailable errors and trigger background recovery.
 * Immediately throws a diagnostic error so the caller can decide when to retry.
 */
export async function withContainerRecovery<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (isContainerUnavailable(err)) {
      const kind = await probeRecoveryKind();
      triggerRecovery(label);
      throw Object.assign(
        new Error(buildContainerDiagnostic(label, err, kind)),
        { containerUnavailable: true },
      );
    }
    throw err;
  }
}
