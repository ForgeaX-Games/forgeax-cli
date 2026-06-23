# Evolve Checklist — 源码修改操作规范

> evolve 模式下修改框架代码时的完整流程。不跳步。

## 开发流程

```
□ RULE_1: 理解 — 用源码导航定位入口，read 源文件后再动手，不靠脑补
□ RULE_2: 实现 — 新 .ts 第一行写 @desc，能力代码放 capabilities/{pkg}/{kind}/，用户路径用 ctx.fs
□ RULE_3: 静态检查 — 对所有改动文件执行 LSP diagnostics，零错误
□ RULE_4: 自测 — src/ 改动 → restart_instance；capabilities/ 改动 → sleep 等热加载。不提交未验证的代码
□ RULE_5: 提交 — submit_mr（conventional commit 格式），不直接 git push
□ RULE_6: Changelog — 架构变更时写 docs/changelog/YYYY-MM-DD.md
□ RULE_7: 汇报 — 做了什么 + MR 链接，不解释过程
```

## submit_mr

| Action | 说明 |
|--------|------|
| `submit`（默认）| 从未提交的变更创建/更新 MR，submit 后自动退出 evolve mode |
| `close` | 关闭指定 iid 的 MR |

提交后自动追踪：merged/closed/新评论/冲突 → 通知。`check_mr_status` 查看状态。

## 源码导航

| 要改什么 | 入口 |
|---------|------|
| 类型/接口 | `src/core/types.ts` |
| Agent 行为 | `base-agent.ts` → `conscious-agent.ts` |
| 事件调度 | `event-bus.ts` + `event-queue.ts` |
| 消息管线 | `src/message/` → `src/session/` → `src/context-window/` → `src/capability/slot/` → `src/capability/tool/` |
| LLM Provider | `src/llm/provider.ts` + `stream.ts` |
| 能力加载 | `src/loaders/base-loader.ts` |
| Scheduler | `src/core/scheduler.ts` |
| Agent 树 | `src/tree/agent-tree.ts` |
| WAL/持久化 | `src/session/event-ledger.ts` + `event-store.ts` |
| 路径管理 | `src/fs/path-manager.ts` |
| 文件监听 | `src/fs/watcher.ts` |
| 默认值/模板 | `src/defaults/agent/` |
| Gateway | `src/gateway/gateway.ts`，路由 `server/routes/`，IPC `instance-handle-ipc.ts` |
| Instance 查询 | `src/instance/instance-queries.ts`（文件）+ `instance.ts`（内存） |
| Capability 编写 | 调用 `ref` 工具 |

## 文件规范

- `.ts` / `.json` / `.md` / `.sh` only，禁止 yaml/toml
- 每个 `.ts` 第一行：`// @desc <English, one line>`
- 能力代码放 `capabilities/{package}/{kind}/`，共享逻辑放 `lib/`

## Changelog

路径：`docs/changelog/YYYY-MM-DD.md`

```markdown
# YYYY-MM-DD
> 仓库: agenteam_os (<branch> 分支)
---
## <标题> (`<commit_id>`)
<动机 + 关键变动纪要>
```
