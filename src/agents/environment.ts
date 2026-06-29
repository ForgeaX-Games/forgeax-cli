/**
 * environment 渲染器(纯函数)—— system prompt 的 `# Environment` 段:
 * Paths + 当前游戏 + Workbench 插件表 + Skills 目录。
 *
 * 单一真相:`builtin/kits/workspace/slots/environment.ts`(老 slot 路径)与
 * `src/kernel/compose-turn-request.ts`(新内核装配器)都从这里 import,**只产文本**。
 * 依赖方向与 `game-charter.ts` 一致:逻辑在 src,builtin 薄壳 import src(单向,无环)。
 * Boundary: 仅 import src-local + @forgeax/types,绝不反向依赖 builtin。
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defaultProjectRoot } from '@forgeax/platform-io';
import { getPluginSnapshot } from "../plugins/registry";
import { pickI18n } from "@forgeax/types";

interface ForgeJson {
  id?: string;
  name?: string;
  entry?: string;
}

function readForgeJson(gameRoot: string): ForgeJson | null {
  const p = join(gameRoot, "forge.json");
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ForgeJson;
  } catch {
    return null;
  }
}

function inferGameSlug(cwd: string, projectRoot: string): string | null {
  const rel = relative(projectRoot, cwd);
  const m = rel.match(/^\.forgeax\/games\/([^/]+)$/);
  return m ? m[1] : null;
}

export interface RenderEnvironmentOpts {
  /** 报给模型的「Working directory」。新内核路径 = 项目根(file 工具相对此解析);
   *  老 slot 路径 = 会话 cwd(游戏目录)。 */
  cwd: string;
  /** 缺省 defaultProjectRoot()。 */
  projectRoot?: string;
  /** 显式游戏 slug;缺省从 cwd 推断(仅老路径 cwd==游戏目录时有效)。 */
  slug?: string | null;
}

/** 纯函数渲染 environment 文本(Paths + Game + Workbench 插件 + Skills)。
 *  老 slot(`environmentSlot`)与新内核装配器(`composeTurnRequest`)共用,单一真相。 */
export function renderEnvironmentText(opts: RenderEnvironmentOpts): string {
  const projectRoot = opts.projectRoot ?? defaultProjectRoot();
  const cwd = opts.cwd;
  const slug = opts.slug ?? inferGameSlug(cwd, projectRoot);
  const gameRoot = slug ? join(projectRoot, ".forgeax", "games", slug) : null;
  const forge = gameRoot ? readForgeJson(gameRoot) : null;

  const lines: string[] = [];
  lines.push("# Environment");
  lines.push("");

  // Paths
  lines.push("## Paths");
  lines.push(`- Working directory: ${cwd}`);
  lines.push(`- Project root: ${projectRoot}`);
  if (slug) {
    lines.push(`- Game slug: ${slug}`);
    lines.push(`- Game dir: .forgeax/games/${slug}/`);
  }
  lines.push("");

  // Game info
  if (forge) {
    lines.push("## Game");
    if (forge.entry) lines.push(`- Entry: ${forge.entry}`);
    if (forge.name && forge.name !== slug) lines.push(`- Name: ${forge.name}`);
    lines.push("");
  }

  // Workbench plugins + skills
  const snap = getPluginSnapshot();
  const workbenches = snap.kinds.workbench;
  const skills = snap.kinds.skills;

  if (workbenches.length > 0 || skills.length > 0) {
    // Workbench table
    if (workbenches.length > 0) {
      lines.push("## Workbench plugins");
      lines.push("| id | data dir | skills |");
      lines.push("| --- | --- | --- |");
      for (const wb of workbenches) {
        if (wb.hidden) continue;
        const wbSkills = skills
          .filter((s) => s.pluginId === wb.pluginId)
          .map((s) => {
            const trigger = s.definition.triggers?.[0];
            if (trigger && trigger.kind === "slash") return `/${trigger.command}`;
            return s.definition.id;
          });
        const dataDir = slug ? inferDataDir(wb.workbenchId, slug) : "—";
        const skillStr = wbSkills.length > 0 ? wbSkills.join(", ") : "—";
        lines.push(`| ${wb.workbenchId} | ${dataDir} | ${skillStr} |`);
      }
      lines.push("");
    }

    // Skills list (including non-workbench skills)
    if (skills.length > 0) {
      lines.push("## Skills");
      for (const s of skills) {
        const trigger = s.definition.triggers?.[0];
        const cmd = trigger && trigger.kind === "slash" ? `/${trigger.command}` : s.definition.id;
        const desc = pickI18n(s.definition.description, "zh") || pickI18n(s.definition.displayName, "zh") || "";
        const short = desc.length > 60 ? desc.slice(0, 57) + "..." : desc;
        lines.push(`- \`${cmd}\` — ${short} (${s.pluginId.replace("@forgeax-plugin/", "")})`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

function inferDataDir(workbenchId: string, slug: string): string {
  // Known conventions for per-game plugin data directories
  const known: Record<string, string> = {
    "wb-character": `characters/`,
    "wb-scene": `wb-scene/`,
    "wb-narrative": `design/`,
    "wb-anim": `anim/`,
    "wb-bgm": `audio/`,
    "wb-items": `items/`,
    "wb-lowpoly-obj": `lowpoly-characters/`,
    "wb-ui": `ui/`,
  };
  const sub = known[workbenchId];
  if (sub) return `.forgeax/games/${slug}/${sub}`;
  return "—";
}
