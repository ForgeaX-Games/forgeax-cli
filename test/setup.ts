/**
 * 测试预载(bunfig.toml `[test].preload`)—— 单测默认走**旧 in-process / provider 路径**。
 *
 * 内核 + sidecar 路径需真 `claude`/`codex` 二进制 + 独立进程,单测不该默认触发(会 spawn/挂)。
 * 故全局把 `FORGEAX_KERNEL` 默认钉为 `cli`(= kernelEnabled() 返回 false → 旧路径)。这让**生产
 * 全局默认翻成内核后,单测仍稳**(ship-gate 闸#1)。需要测内核路径的用例可显式
 * `process.env.FORGEAX_KERNEL='kernel'` 覆盖;内核/soul/sidecar 单测不经 kernelEnabled,不受影响。
 */
if (!process.env.FORGEAX_KERNEL) process.env.FORGEAX_KERNEL = 'cli';
