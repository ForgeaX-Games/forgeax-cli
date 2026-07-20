/**
 * Shell command splitter (E-01) — **SSOT 已上移**(046 楔子1-补)。
 *
 * 实现现活在共享契约包 `@forgeax/types`(`shell-split.ts`),与 permission-rules
 * 一同被 cli 编排层复用;本文件只余 re-export(core 内 import 位点与单测零改动)。
 */
export { isShellToolName, splitShellCommand, stripEnvAssignments, type ShellSplit } from '@forgeax/types';
