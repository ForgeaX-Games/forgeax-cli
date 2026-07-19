/**
 * bun test 全局 preload(bunfig.toml [test].preload)—— 单测密闭性护栏。
 *
 * 把整个测试进程的 `FORGEAX_CONFIG_DIR` 强制指到一次性临时目录,使任何经
 * `configHomeDir()` 的读写(settings / trust / …)都落在沙盒里,**绝不触碰真实
 * `~/.forgeax/`**。背景:driver.setModel() 会 updateUserSettings 落盘持久化,
 * 曾有单测借此把测试模型写进真实 `~/.forgeax/settings.json`,导致用户下次启动
 * 模型被静默改掉(settings.model 优先级高于 ANTHROPIC_MODEL)。
 *
 * 无条件覆盖(即使 shell 已设):单测密闭性 > 外部指定;需要自定目录的测试
 * 自行 save/restore 本值(既有 trust-gate / cli-cases 模式)。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FORGEAX_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'forgeax-test-config-'));
