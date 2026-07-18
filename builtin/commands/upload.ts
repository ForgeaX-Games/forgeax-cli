// @desc Command module: upload — push the workspace's .forgeax to the shared GitHub repo
//
// Two-phase confirm, execute-only (the UI command path — Composer.tsx + store.ts —
// only routes hasExecute commands and never calls /query, so a hasQuery dry-run
// would be unreachable):
//
//   upload                      → run the dry-run plan, return it + a confirm nonce; no push
//   upload confirm <nonce>      → validate the nonce, then push                     hasExecute
//   upload-log                  → tail the last ~10 audit entries                   hasExecute
//
// All path/credential resolution lives in src/upload (defaults to
// FORGEAX_PROJECT_ROOT). A non-empty env token overrides the compiled built-in
// fallback; neither credential is accepted as an argument or returned.

import type { CommandModule } from "../../src/commands/types";
import { planUpload, uploadWorkspace, tailUploadLog } from "../../src/upload";

const upload: CommandModule = {
  async list() {
    return [
      {
        name: "upload",
        description: "Upload this workspace's .forgeax to the shared GitHub repo (run once for a plan, then `upload confirm <nonce>`)",
        hasQuery: false,
        hasExecute: true,
      },
      {
        name: "upload-log",
        description: "Show the last upload attempts (audit log)",
        hasQuery: false,
        hasExecute: true,
      },
    ];
  },

  async execute(name, args) {
    if (name === "upload-log") {
      return tailUploadLog({ limit: 10 });
    }
    // name === "upload"
    if ((args[0] ?? "").trim() === "confirm") {
      const nonce = (args[1] ?? "").trim();
      return await uploadWorkspace(nonce);
    }
    return planUpload();
  },
};

export default upload;
