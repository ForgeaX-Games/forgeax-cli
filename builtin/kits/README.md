# builtin/kits/

仓库自带的 kit 包根目录。属于 4 层 overlay 中的最底层（`builtin`），运行时通过
`PathManager.builtin().resourceDir("kits")` 解析。

## 4 层叠加（last wins）

```
builtin   ← 本目录
user      ← ~/.forgeax/kits/                              (用户 / marketplace)
session   ← ~/.forgeax/sessions/<sid>/kits/               (per-session override)
agent     ← ~/.forgeax/sessions/<sid>/agents/<path>/kits/ (per-agent override)
```

**override 粒度是整个 kit 包**：高层若存在 `kits/<name>/` 目录，低层同名包整套被
替换 —— 不做 per-file 合并（避免 `lib/` import 路径 / `condition.ts` 出处歧义）。

## 单个 kit 包结构

```
kits/<kit-name>/
  ├─ condition.ts          # default export: (ctx) => boolean
  │                        # optional named exports: configDefaults, agentDefaults
  ├─ tools/<name>.ts       # default export: ToolDefinition
  ├─ slots/<name>.ts       # default export: (ctx) => ContextSlot
  ├─ plugins/<name>.ts     # default export: (ctx) => PluginSource
  └─ lib/                  # 内部共享（不被扫描；ESM resolve-hook 会跟踪 dep）
```

**命名规则**：

- 包名 = 目录名（snake_case）
- LLM 看到的 tool/slot/plugin 名 = 文件名去 `.ts`
- 内部存储 key = 限定 `<kit>/<kind>/<name>`

## 当前状态

- `workspace/` —— 已落地（2026-05-20）。完整的文件 IO + shell 工具集
  （read_file / write_file / edit_file / multi_edit / apply_patch /
  glob / grep / list_dir / shell），从 `agenteam-os-ref/capabilities/workspace/`
  移植，依赖 `ctx.fs`（host fs bridge）+ `ctx.terminal`（持久 bash session）。

- `agent_manage/` / `context_compression/` / `memory/` / `skills/` —— 待补。
  优先级见 [`docs/features/runtime-rewrite-gaps.md`](../../../docs/features/runtime-rewrite-gaps.md) §B1。

## 推荐第一批 builtin kit

按 agenteam-os 的现成集合反推，下面这些放 `builtin/` 最合适（跨 session 通用、
风险低、不依赖第三方 key）：

- `workspace/`        — file IO（read_file / write_file / list / search）✅
- `agent_manage/`     — spawn / despawn / heartbeat / send_message
- `context_compression/` — 自动 micro / full compaction 触发
- `memory/`           — KV 存储 + recognition slot
- `skills/`           — skill marketplace 拉取 + 索引

需要 key / 第三方账号的（discord / web）→ 默认放 `user/` 层，让用户按需开。

## agent-overrides.json 已废弃

历史版本将 kit `configDefaults` / `agentDefaults` 写到
`<sid>/agents/<path>/agent-overrides.json`。本轮（2026-05-20）该机制砍掉 ——
kit 默认值直接 patch 进 `agent.json`（已存在的字段不覆盖）。理由：
单一 SSOT 简化模型，少一处脏盘 + reload 路径。`path-manager.AgentLayerAPI.agentOverrides()`
方法保留但已不被任何 caller 调用，后续清理。
