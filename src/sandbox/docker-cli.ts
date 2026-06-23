// @desc Thin wrapper for `docker` CLI subprocess — shared by sandbox modules
import { spawn } from "node:child_process";

/**
 * Execute a `docker` subcommand and return its stdout (trimmed).
 * Throws Error with stderr content if the command fails.
 *
 * Extracted from manager.ts so container-setup.ts / image-manager.ts can
 * share it without creating a manager.ts ↔ helper circular import.
 */
export function runDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`docker ${args[0]} failed (code ${code}): ${stderr.trim()}`));
    });
    child.on("error", reject);
  });
}
