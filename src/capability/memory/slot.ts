/**
 * Memory slot + index rebuild — resident MEMORY.md index injection.
 *
 * index 常驻 + 会话内记忆化(对齐 cc)
 * system:memory slot 注入 `MEMORY.md` 索引正文(常驻、每条一行供模型挑文件召回),
 * **封顶 MEMORY_BUDGET.entrypointMaxLines / entrypointMaxBytes**。topic 文件的选择性
 * 召回作 system-reminder 由 host 在 loop ingress 注入(走 memory_search),slot 只管常驻索引。
 *
 * **记忆化(缓存前缀稳定性)**:slot 落在 system prompt 静态段(boundary 之前、进缓存
 * 前缀),但 `MEMORY.md` 会被会话中途的 `remember` / auto-extract 重写——若每轮重读,
 * 静态段字节漂移 → 前缀缓存整体失效(实测一次 miss 全量重计费)。故 render 结果按
 * slot 实例记忆化(对齐 cc:context 每会话装配一次进首条消息,中途文件变化只走
 * append-only 提醒,绝不回改已缓存前缀)。中途新写的记忆经 `remember` 工具结果里的
 * `indexLine`(append-only 进历史)+ auto recall 可见,常驻索引到下一个失效点才刷新。
 * 失效点 = `/clear`(SessionEnd reason='clear')与 compaction(CompactionApplied)——
 * 两处缓存前缀本就作废,刷新零额外成本;订阅在 pack 的 invalidator plugin(index.ts)。
 *
 * `rebuildIndex` 扫盘重建 `MEMORY.md`(供 `remember` 写后调用),与索引读保持一致。
 * core 不解释 type taxonomy:索引行原样带 frontmatter 的 `[type]` 标签。
 * Boundary: 仅 import core-local 类型。
 */
import type { SandboxFs } from '../../inject/types';
import type { MemorySlot } from '../memory-seam';
import { MEMORY_BUDGET } from '../memory-seam';
import { scanMemoryFiles, formatManifest, MEMORY_INDEX_FILE, type MemoryHeader } from './scan';

function join(a: string, b: string): string {
  if (a.endsWith('/')) return a + b;
  return `${a}/${b}`;
}

/** 把索引文本封到 entrypoint 预算(先行后字节)。 */
function clampEntrypoint(text: string): string {
  let out = text;
  const lines = out.split('\n');
  if (lines.length > MEMORY_BUDGET.entrypointMaxLines) {
    out = lines.slice(0, MEMORY_BUDGET.entrypointMaxLines).join('\n');
  }
  if (out.length > MEMORY_BUDGET.entrypointMaxBytes) {
    out = out.slice(0, MEMORY_BUDGET.entrypointMaxBytes);
  }
  return out;
}

/**
 * 扫盘重建 `MEMORY.md` 索引(每条一行:manifest 格式)。`remember` 写后调用以保持一致。
 * 经注入的 SandboxFs 写盘;封到 entrypoint 预算。返回扫描到的 headers(供调用方派生
 * 单条 indexLine 等,免二次扫盘——§2 Derive)。
 */
export function rebuildIndex(fs: SandboxFs, memoryDir: string): MemoryHeader[] {
  const headers = scanMemoryFiles(fs, memoryDir);
  const manifest = clampEntrypoint(formatManifest(headers));
  const content = `# MEMORY index\n\n> Resident index: one line per file. Pick files to recall via memory_search.\n\n${manifest}\n`;
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeTextSync(join(memoryDir, MEMORY_INDEX_FILE), content);
  return headers;
}

export interface MemorySlotDeps {
  memoryDir: string;
  sandboxFs: SandboxFs;
}

/** 「未渲染」sentinel:区分「还没算过」与「算过、结果是 null(本会话不注入)」。 */
const UNRENDERED = Symbol('unrendered');

/** memory slot + 记忆化失效句柄(pack 的 invalidator plugin 在 /clear、compaction 时调)。 */
export interface ResidentMemorySlot extends MemorySlot {
  /** 丢弃记忆化的渲染结果;下次 render 重读磁盘。仅在缓存前缀本就作废的边界调用。 */
  invalidate(): void;
}

/**
 * memory slot:注入常驻 `MEMORY.md` 索引(封顶 entrypoint 预算)。索引缺失 → 实时
 * 用 scan 派生一份(不写盘),仍空 → null(本轮不注入)。**渲染结果按实例记忆化**
 * (含 null——会话中途首写也不打爆前缀),invalidate() 后才重读磁盘(见文件头)。
 */
export function makeMemorySlot(deps: MemorySlotDeps): ResidentMemorySlot {
  const { memoryDir, sandboxFs } = deps;
  let cached: string | null | typeof UNRENDERED = UNRENDERED;
  return {
    name: 'memory',
    dynamic: false,
    render() {
      if (cached !== UNRENDERED) return cached;
      const indexPath = join(memoryDir, MEMORY_INDEX_FILE);
      let body = '';
      if (sandboxFs.existsSync(indexPath)) {
        try {
          body = sandboxFs.readTextSync(indexPath);
        } catch {
          body = '';
        }
      }
      if (!body.trim()) {
        // 索引缺失:实时从 scan 派生 manifest(不写盘),作 fallback。
        const manifest = formatManifest(scanMemoryFiles(sandboxFs, memoryDir));
        if (!manifest.trim()) {
          cached = null;
          return cached;
        }
        body = `# MEMORY index\n\n${manifest}\n`;
      }
      cached = clampEntrypoint(body);
      return cached;
    },
    invalidate() {
      cached = UNRENDERED;
    },
  };
}
