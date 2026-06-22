import type {
  ToolDefinition,
  AgentContext,
} from "../core/types.js";
import { isPlainObject } from "../utils.js";
import { BaseLoader } from "./base-loader.js";
import { ensureToolKeyPlaceholders } from "../fs/tool-keys.js";
import { getPathManager } from "../fs/path-manager.js";
import { bareName } from "../registries/name-lookup.js";
import { withModelFeedback } from "../core/logger.js";

type ToolLike = Partial<ToolDefinition>;

type ToolFactory = { default?: ToolLike };

function isValidInputSchema(value: unknown): value is ToolDefinition["input_schema"] {
  if (!isPlainObject(value)) return false;
  if (value.type !== "object") return false;
  return isPlainObject(value.properties);
}

function normalizeToolDefinition(
  def: ToolLike | undefined,
  exposedName: string,
): ToolDefinition | null {
  if (!def) return null;

  // name is optional — derived from filename via exposedName.
  // If declared, it must match the bare name (filename without extension).
  // Wrap in withModelFeedback so agents writing their own tools see the
  // mismatch as a model-visible warning, not just a log line.
  if (def.name != null) {
    const expected = bareName(exposedName);
    if (def.name !== expected) {
      withModelFeedback(() =>
        console.warn(`[ToolLoader] "${exposedName}": declared name "${def.name}" does not match filename "${expected}", using filename`),
      );
    }
  }

  if (typeof def.description !== "string") {
    console.warn(`[ToolLoader] skipped "${exposedName}": missing string "description"`);
    return null;
  }
  if (typeof def.execute !== "function") {
    console.warn(`[ToolLoader] skipped "${exposedName}": missing function "execute"`);
    return null;
  }

  if (!isValidInputSchema(def.input_schema)) {
    console.warn(
      `[ToolLoader] skipped "${exposedName}": missing valid "input_schema" object schema`,
    );
    return null;
  }

  // Pass-through over allow-list pick: the source `.ts` file is already
  // `satisfies ToolDefinition` so non-schema fields can't sneak in, and
  // adding new fields to ToolDefinition no longer requires a parallel
  // edit here. Required fields are re-asserted to satisfy the cast after
  // the type-narrowing checks above.
  return {
    ...def,
    name: exposedName,
    description: def.description,
    input_schema: def.input_schema,
    execute: def.execute,
  } as ToolDefinition;
}

/**
 * Stateless tool loader. Returns ToolDefinition[] from disk scan.
 *
 * Files that don't export a valid ToolDefinition (with name + execute) are
 * silently skipped. This allows placing shared utilities in the same folder.
 */
export class ToolLoader extends BaseLoader<ToolFactory, ToolDefinition | null> {
  protected readonly kind = "tools" as const;

  createInstance(
    factory: ToolFactory,
    _ctx: AgentContext,
    name: string,
  ): ToolDefinition | null {
    return normalizeToolDefinition(factory.default, name);
  }

  async load(ctx: AgentContext): Promise<Map<string, ToolDefinition>> {
    const registry = await this.loadOnce(ctx);
    const result = new Map<string, ToolDefinition>();
    const allRequiredKeys: Array<{ key: string; description: string }> = [];

    for (const [key, tool] of registry) {
      if (tool !== null) {
        result.set(key, tool);
        if (tool.requiredKeys?.length) {
          allRequiredKeys.push(...tool.requiredKeys);
        }
      }
    }

    // Batch-register all declared tool key placeholders
    if (allRequiredKeys.length > 0) {
      ensureToolKeyPlaceholders(getPathManager(), allRequiredKeys).catch((err) => {
        console.debug(`[ToolLoader] ensureToolKeyPlaceholders failed: ${err?.message ?? err}`);
      });
    }

    return result;
  }
}
