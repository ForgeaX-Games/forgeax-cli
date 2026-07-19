/**
 * Instructions capability pack —— 分层指令装载(AGENTS.md / CLAUDE.md + rules + @import)。
 *
 * core 只用 `/init` **生成**指令文件,过去运行时**从不加载** → agent 对项目/用户约定一无所知。
 * 本 pack 补上「通用 coding agent」缺的这一环:发现 → @import 展开 → 无条件 rules → 单 static slot。
 *
 * host 经 `instructionsPack({ cwd, userForgeax, userClaude })` 装配(dirs 由 host 从
 * configHomeDir()/homedir() 算出,发现层不读 env)。构造期一次性快照文本 → static slot。
 *
 * **SSOT**:发现/解析/激活层只在 `./discover` + `./import` + `./load` 实现一次;skill 的
 * conditional-paths、memory 的 rules 后续复用,勿在三处各写一遍。
 *
 * Boundary: 仅 import core-local 类型 + node:(装配期读盘)。
 */
import type { CapabilityPack } from '../types';
import { loadInstructions } from './load';
import { makeInstructionsSlot } from './slot';
import type { InstructionDirs } from './discover';

export { discoverInstructions, isPureAliasOf } from './discover';
export type {
  Discovered,
  DiscoveredFile,
  DiscoveredRule,
  InstructionDirs,
  InstructionLabel,
  RuleLabel,
} from './discover';
export { expandImports, loadAndExpand, resolveImportPath, MAX_IMPORT_DEPTH, MAX_FILE_CHARS } from './import';
export { loadInstructions, type LoadInstructionsResult } from './load';
export { makeInstructionsSlot } from './slot';

/**
 * 组装 instructions capability pack。装配期装载并快照指令文本;无指令 → slots 为空
 * (干净项目不受扰)。
 */
export function instructionsPack(dirs: InstructionDirs): CapabilityPack {
  const { text } = loadInstructions(dirs);
  return {
    name: 'instructions',
    layer: 'user',
    slots: text.trim() ? [makeInstructionsSlot(text)] : [],
  };
}
