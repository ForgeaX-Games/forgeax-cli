/**
 * Scaffold a "default" game stub in an arbitrary workspace dir.
 *
 * When the user opens a non-game system directory as a ForgeaX workspace
 * (POST /api/projects/open with initIfMissing=true), the engine pipeline
 * still expects to dynamic-import a GameEntry. The canonical entry is a
 * root-level main.ts (resolved via forge.json `entry`, see
 * packages/build/engine-src/src/main.ts).
 *
 * Rather than carving a "non-game preview" branch into the engine, we drop a
 * minimal GameEntry into .forgeax/games/workspace/main.ts that hides the
 * three.js canvas and injects a plain-HTML placeholder. Users can then edit
 * that file to put whatever DOM/HTML/JS they want — vite HMR is wired through
 * the existing engine pipeline.
 *
 * Idempotent: never overwrites an existing main.ts.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface ScaffoldResult {
  /** True if we wrote new files; false if the stub already existed. */
  created: boolean;
  slug: 'workspace';
  absDir: string;
}

const STUB_MAIN_TS = `// Auto-scaffolded by ForgeaX when you opened this directory as a workspace.
// Edit freely — saving this file triggers vite HMR in the Preview iframe.
//
// The engine expects a GameEntry export (see packages/build/engine-src/src/types.ts):
//   type GameEntry = (ctx: GameContext) => void;
// Here we hide the three.js canvas and take over the iframe with raw HTML.

export default function start(ctx) {
  try { ctx.renderer.domElement.style.display = 'none'; } catch { /* ignore */ }
  const app = document.getElementById('app') || document.body;
  app.innerHTML = \`
    <div style="font-family:system-ui,sans-serif;color:#fff;padding:32px;line-height:1.55;max-width:720px">
      <h2 style="color:#D4FF48;margin-top:0">\${WORKSPACE_NAME}</h2>
      <p>这是一个非游戏 workspace 的默认 HTML 占位 — 由 ForgeaX 在你打开此目录时 scaffold。</p>
      <p>替换这块内容：编辑文件</p>
      <pre style="background:#111;padding:12px;border-radius:6px;overflow-x:auto">.forgeax/games/workspace/main.ts</pre>
      <p style="opacity:0.6">vite HMR 已挂上，保存后这个 iframe 会自动刷新。</p>
    </div>\`;
}
`;

export function scaffoldDefaultWorkspace(workspaceDir: string): ScaffoldResult {
  const gameDir = join(workspaceDir, '.forgeax', 'games', 'workspace');
  // Canonical convention: entry is a root-level main.ts (sibling to src/),
  // resolved via forge.json `entry`. (Was src/main.ts before the rename.)
  const mainTs = join(gameDir, 'main.ts');
  const forgeJson = join(gameDir, 'forge.json');
  const result: ScaffoldResult = { created: false, slug: 'workspace', absDir: gameDir };

  mkdirSync(join(workspaceDir, '.forgeax', 'agenteam-state'), { recursive: true });
  mkdirSync(gameDir, { recursive: true });

  if (!existsSync(mainTs)) {
    const name = basename(workspaceDir) || 'workspace';
    const content = STUB_MAIN_TS.replace('${WORKSPACE_NAME}', JSON.stringify(name).slice(1, -1));
    writeFileSync(mainTs, content, 'utf-8');
    if (!existsSync(forgeJson)) {
      writeFileSync(
        forgeJson,
        JSON.stringify({ id: 'workspace', name, entry: 'main.ts' }, null, 2) + '\n',
        'utf-8',
      );
    }
    result.created = true;
  }

  return result;
}
