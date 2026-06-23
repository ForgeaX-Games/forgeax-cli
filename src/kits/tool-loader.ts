/** KitToolLoader —— stateless tool kit loader.
 *
 *  Files that don't export a valid ToolDefinition (description + input_schema
 *  + execute) are silently skipped — shared utility files can live next to
 *  tool files in the same `tools/` dir.
 *
 *  Name policy (matches ref agenteam-os-ref/src/loaders/tool-loader.ts):
 *  - filename without `.ts` = bare tool name (LLM-facing)
 *  - storage key = qualified `kit/tools/<name>` (BaseKitLoader managed)
 *  - if file declares `name` and it disagrees with the bare filename,
 *    issue a model-visible warning and use the filename.
 *
 *  Ported from `agenteam-os-ref/src/loaders/tool-loader.ts`. */

import type { ToolDefinition, AgentContext } from "../core/types";
import { withModelFeedback } from "../core/logger";
import { isPlainObject } from "../utils";
import { BaseKitLoader } from "./base-loader";
import { bareName } from "./name-lookup";

type ToolLike = Partial<ToolDefinition>;
type ToolFactory = { default?: ToolLike };

function isValidInputSchema(value: unknown): value is ToolDefinition["input_schema"] {
  if (!isPlainObject(value)) return false;
  if ((value as Record<string, unknown>).type !== "object") return false;
  return isPlainObject((value as Record<string, unknown>).properties);
}

function normalizeToolDefinition(
  def: ToolLike | undefined,
  exposedName: string,
): ToolDefinition | null {
  if (!def) return null;

  // `exposedName` here is the qualified key (`kit/tools/foo`). Pull the bare
  // tail; what the LLM sees is the bare, what we *store* is qualified.
  if (def.name != null) {
    const expected = bareName(exposedName);
    if (def.name !== expected) {
      withModelFeedback(() =>
        console.warn(
          `[KitToolLoader] "${exposedName}": declared name "${def.name}" does not match filename "${expected}", using filename`,
        ),
      );
    }
  }

  if (typeof def.description !== "string") {
    console.warn(`[KitToolLoader] skipped "${exposedName}": missing string "description"`);
    return null;
  }
  if (typeof def.execute !== "function") {
    console.warn(`[KitToolLoader] skipped "${exposedName}": missing function "execute"`);
    return null;
  }
  if (!isValidInputSchema(def.input_schema)) {
    console.warn(
      `[KitToolLoader] skipped "${exposedName}": missing valid "input_schema" object schema`,
    );
    return null;
  }

  // Pass-through over allow-list pick: source `.ts` is `satisfies
  // ToolDefinition`, so unknown fields can't sneak in. Required fields are
  // re-asserted after the narrowing checks above.
  return {
    ...def,
    name: exposedName,                              // qualified — LLM bare-mapping happens in ConsciousAgent
    description: def.description,
    input_schema: def.input_schema,
    execute: def.execute,
  } as ToolDefinition;
}

export class KitToolLoader extends BaseKitLoader<ToolFactory, ToolDefinition | null> {
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
    for (const [key, tool] of registry) {
      if (tool !== null) result.set(key, tool);
    }
    // NOTE: ref also calls `ensureToolKeyPlaceholders(allRequiredKeys)`. forgeax
    // 的 key 体系（packages/server/src/key/...）独立运转；后续 B1.x 接 keys 系
    // 统时再加，不在 B1.2 范围内。
    return result;
  }
}
