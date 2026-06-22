/**
 * @desc Instance Handle — re-exports types from core/types.ts and createInstance from instance/instance.ts
 *
 * This file is kept for backward compatibility with existing imports.
 * New code should import directly from "../core/types.js" or "../instance/instance.js".
 */

export type { InstanceHandle, InstanceConfig, TeamInfoPayload, InstanceStatus } from "../core/types.js";
export { createInstance } from "../instance/instance.js";
