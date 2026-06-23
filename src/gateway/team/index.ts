/** @desc Team module — re-exports for gateway consumption */

export { loadPack } from "./load.js";
export { updateTeam } from "./update.js";
export { saveBackup, restoreBackup, deleteBackup } from "./backup.js";
export { readManifestRaw, readManifest, updateManifest, teamInfo } from "./manifest.js";
export { removeContainers } from "./containers.js";
export { listPackEntries, generateIncludePack, parseIncludePack, readUserSection } from "./include-pack.js";
export { previewSync, executeSync, bumpVersion } from "./sync-back.js";
export type { TeamManifest, UpdateTeamResult, SyncPreview } from "./types.js";
export { extractPackJson, buildManifestFromPack } from "./types.js";
