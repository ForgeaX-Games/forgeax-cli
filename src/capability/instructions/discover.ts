/**
 * 分层指令发现 —— 跨 user / project / local 三层定位 `AGENTS.md` / `CLAUDE.md` 与 rules 目录。
 *
 * **取向(SSOT)**:`AGENTS.md` 是 canonical(Agentic AI Foundation 开放标准),`CLAUDE.md`
 * 是一等兼容别名;两者都读、不二选一。rules 同一姿态:`.forgeax/rules/*.md`(canonical)
 * + `.claude/rules/*.md`(兼容别名)。这是「发现层」的唯一实现点——skill conditional-paths、
 * memory rules 后续都复用它,别在三处各写一遍。
 *
 * 层次与目录(host 传入绝对路径,发现层不读 env,保 FORGEAX_CONFIG_DIR 策略住在 host):
 *   - user:    `<userForgeax>/AGENTS.md` + `<userClaude>/CLAUDE.md`;rules 同理两目录。
 *   - project: `<cwd>/AGENTS.md` + `<cwd>/CLAUDE.md`;rules `<cwd>/.forgeax/rules` + `<cwd>/.claude/rules`。
 *   - local:   `<cwd>/AGENTS.local.md` + `<cwd>/CLAUDE.local.md`(个人 gitignore 覆盖)。
 * 顺序 user → project → local(broad→specific;都进稳定缓存前缀,顺序只影响权重呈现)。
 *
 * **同目录去重**:同一目录下 AGENTS.md 与 CLAUDE.md 都存在、且 CLAUDE.md 内容仅是指向
 * 兄弟 AGENTS.md 的 `@import`(如本仓 `@AGENTS.md`)→ 去重(只收 AGENTS.md);否则两者都收
 * (各自独立正文)。user 层的 AGENTS.md 与 CLAUDE.md 在**不同目录**,不触发同目录去重。
 *
 * Boundary: 仅 import core-local 类型 + node:。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveImportPath } from './import';

export type InstructionLabel =
  | 'user instructions'
  | 'project instructions'
  | 'local instructions';
export type RuleLabel = 'user rule' | 'project rule';

export interface DiscoveredFile {
  /** 绝对路径。 */
  path: string;
  label: InstructionLabel;
}
export interface DiscoveredRule {
  path: string;
  label: RuleLabel;
}

export interface Discovered {
  /** 指令文件(顺序即注入顺序:user → project → local)。 */
  files: DiscoveredFile[];
  /** rules 文件(user → project;各目录内文件名排序)。 */
  rules: DiscoveredRule[];
}

/** host 提供的层目录(全绝对路径)。 */
export interface InstructionDirs {
  /** 项目根(= cwd)。 */
  cwd: string;
  /** 用户 canonical 配置根(`~/.forgeax` 或 FORGEAX_CONFIG_DIR)。 */
  userForgeax: string;
  /** 用户 CC 兼容配置根(`~/.claude`)。 */
  userClaude: string;
  /** 文件读取器(默认 node:fs;单测可注入)。 */
  readFile?: (abs: string) => string;
  /** 目录列举器(默认 node:fs;单测可注入)。 */
  readDir?: (abs: string) => string[];
  /** 存在性判定(默认 node:fs;单测可注入)。 */
  exists?: (abs: string) => boolean;
}

function safeRead(readFile: (abs: string) => string, abs: string): string | null {
  try {
    return readFile(abs);
  } catch {
    return null;
  }
}

/**
 * 判定 claudeMdPath 是否「仅指向兄弟 agentsMdPath 的 @import 别名」。
 * 规则:去掉空行 / 纯注释(`<!-- -->` 行或 `#` 标题行)后,剩余内容行全是 `@import`,
 * 且解析出的目标集非空、全部落在兄弟 AGENTS.md 上 → 视作纯别名(去重)。
 */
export function isPureAliasOf(
  claudeMdPath: string,
  agentsMdPath: string,
  claudeDir: string,
  readFile: (abs: string) => string,
): boolean {
  const content = safeRead(readFile, claudeMdPath);
  if (content === null) return false;
  const importRe = /^@((?:[^\s\\]|\\ )+)$/;
  let sawImport = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('#')) continue; // markdown 标题/注释行
    if (line.startsWith('<!--')) continue; // html 注释行
    const m = importRe.exec(line);
    if (!m) return false; // 出现非 import 正文 → 不是纯别名
    const target = resolveImportPath(m[1]!, claudeDir);
    if (target !== agentsMdPath) return false; // import 指向别处 → 不是纯别名
    sawImport = true;
  }
  return sawImport;
}

/**
 * 收集某目录下 `AGENTS.md` + `CLAUDE.md` 一对(应用同目录去重)。
 * agentsName / claudeName 可覆盖(local 层用 `AGENTS.local.md` / `CLAUDE.local.md`)。
 */
function collectPair(
  dir: string,
  label: InstructionLabel,
  names: { agents: string; claude: string },
  io: { exists: (abs: string) => boolean; readFile: (abs: string) => string },
): DiscoveredFile[] {
  const agentsPath = join(dir, names.agents);
  const claudePath = join(dir, names.claude);
  const hasAgents = io.exists(agentsPath);
  const hasClaude = io.exists(claudePath);
  const out: DiscoveredFile[] = [];
  if (hasAgents) out.push({ path: agentsPath, label });
  if (hasClaude) {
    // 同目录去重:两者都在且 CLAUDE.md 仅 @import 兄弟 AGENTS.md → 略过 CLAUDE.md。
    if (hasAgents && isPureAliasOf(claudePath, agentsPath, dir, io.readFile)) {
      return out;
    }
    out.push({ path: claudePath, label });
  }
  return out;
}

/** 列举某 rules 目录下的 `*.md`(排序;目录缺失 → 空)。 */
function collectRules(
  dir: string,
  label: RuleLabel,
  io: { readDir: (abs: string) => string[] },
): DiscoveredRule[] {
  let names: string[];
  try {
    names = io.readDir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.md'))
    .sort()
    .map((n) => ({ path: join(dir, n), label }));
}

/** 跨三层发现指令文件 + rules(见文件头)。 */
export function discoverInstructions(dirs: InstructionDirs): Discovered {
  const exists = dirs.exists ?? ((abs: string) => existsSync(abs));
  const readFile = dirs.readFile ?? ((abs: string) => readFileSync(abs, 'utf8'));
  const readDir = dirs.readDir ?? ((abs: string) => readdirSync(abs));
  const io = { exists, readFile };

  const files: DiscoveredFile[] = [];
  // user 层:AGENTS.md 与 CLAUDE.md 在不同目录 → 各自独立收(无同目录去重)。
  if (exists(join(dirs.userForgeax, 'AGENTS.md'))) {
    files.push({ path: join(dirs.userForgeax, 'AGENTS.md'), label: 'user instructions' });
  }
  if (exists(join(dirs.userClaude, 'CLAUDE.md'))) {
    files.push({ path: join(dirs.userClaude, 'CLAUDE.md'), label: 'user instructions' });
  }
  // project 层:同目录(cwd)AGENTS.md + CLAUDE.md,应用去重。
  files.push(...collectPair(dirs.cwd, 'project instructions', { agents: 'AGENTS.md', claude: 'CLAUDE.md' }, io));
  // local 层:同目录 AGENTS.local.md + CLAUDE.local.md,应用去重。
  files.push(
    ...collectPair(dirs.cwd, 'local instructions', { agents: 'AGENTS.local.md', claude: 'CLAUDE.local.md' }, io),
  );

  const rules: DiscoveredRule[] = [
    ...collectRules(join(dirs.userForgeax, 'rules'), 'user rule', { readDir }),
    ...collectRules(join(dirs.userClaude, 'rules'), 'user rule', { readDir }),
    ...collectRules(join(dirs.cwd, '.forgeax', 'rules'), 'project rule', { readDir }),
    ...collectRules(join(dirs.cwd, '.claude', 'rules'), 'project rule', { readDir }),
  ];

  return { files, rules };
}
