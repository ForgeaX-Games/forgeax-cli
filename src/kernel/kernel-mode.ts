/**
 * kernelEnabled —— sessions/cli 主对话是否走**内核 + sidecar 整套栈**。
 *
 * **ship-gate 已翻:全局默认 = 内核 + sidecar**(sidecar 经 `sidecarEnabled()` 耦合默认同开)。
 * 三道前置闸已通:① 测试预载默认 cli(套件耐默认开);② 权限卡真 sid + 核心 parity(矩阵见
 * ship-gate-parity-matrix.md);③ R3-02 kernel-only 擦 key(`FORGEAX_KERNEL_ONLY=1`)。多模态图片
 * 输入当前为 UI 占位(非实流)→ 不构成回归;模型级联回退/逐工具/ask_user e2e 列 P2 backlog。
 *
 * 逃生回旧 in-process 路径:`FORGEAX_KERNEL=cli`(或 `=off`)/ `FORGEAX_NO_KERNEL=1` /
 * `<projectRoot>/.forgeax/use-cli` 文件(部署级)。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultProjectRoot } from '@forgeax/platform-io';

export function kernelEnabled(projectRoot?: string): boolean {
  const k = (process.env.FORGEAX_KERNEL ?? '').trim();
  if (k === 'cli' || k === 'off' || process.env.FORGEAX_NO_KERNEL === '1') return false; // 显式逃生 → 旧路径
  if (k === 'kernel') return true; // 显式开
  try {
    // ship-gate 已翻:**全局默认 = 内核 + sidecar**。部署级逃生回旧路径:放 `.forgeax/use-cli`。
    if (existsSync(resolve(projectRoot ?? defaultProjectRoot(), '.forgeax/use-cli'))) return false;
  } catch {
    /* ignore */
  }
  return true; // 默认走内核(三闸已通;多模态图片输入当前为 UI 占位非实流,不构成回归)
}

/** sidecar 是否启用(与内核耦合,默认 ON;`FORGEAX_SIDECAR=off` 逃生回内核直 spawn)。 */
export function sidecarEnabled(): boolean {
  return (process.env.FORGEAX_SIDECAR ?? '').trim() !== 'off';
}
