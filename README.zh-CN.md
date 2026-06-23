# ForgeaX Studio — forgeax-cli

[English](./README.md) · [简体中文](./README.zh-CN.md) · [↑ studio](https://github.com/ForgeaX-Games/forgeax-studio)

> **多 agent 编排内核 —— 显式的 AgentTree、XML 执行账本、以及由 slot 组装且对缓存友好的提示词。驱动 Forge 及其子 agent 的就是这个运行时。**

`forgeax-cli` 是 ForgeaX 的 agent 运行时内核。它**由 `@forgeax/server` 进程内托管**,把一次聊天
请求变成一支协作的 agent 团队:规划、委派、编写引擎代码、汇报结果。多数「agent 框架」不过是对
单次模型调用套了层薄循环,而这里是一个真正的编排运行时:带类型的 agent 树、可回放的消息账本、
沙箱化执行,以及由优先级片段组装出的提示词。

## 自带你的 agent —— 用你已经在用的订阅

ForgeaX **不绑定任何模型厂商**。内核通过可插拔的 **driver** 层(`cli-*` 提供者)驱动 Forge,
因此你可以用**已经在付费的编程 agent 订阅**来跑整个 studio——或者用一个普通的 API key:

- **[the reference agent CLI](https://claude.com/product/claude-code)** —— 用你的 **Claude Pro / Max**
  计划,或一个 **Anthropic API key**。
- **[OpenAI Codex](https://developers.openai.com/codex)** —— 登录你的 **ChatGPT Plus / Pro**
  计划,或用一个 **OpenAI API key**。
- **[Cursor](https://cursor.com/cli)** —— 通过 Cursor Agent CLI 连接你的 **Cursor Pro** 订阅。

人格独立于 driver:同一个 **Forge** 能跑在你选择的任一 agent 上,切换 provider 无需改动任何代码。
不必为 AI 付第二份钱,也不绑定任何厂商。

## 它为何不同

- **agent 团队是显式的数据结构,而非靠提示词凑出来的涌现。** 关系存在于内存中的 **AgentTree**,
  有三种清晰角色——**router**(路由请求,不干活)、**admin**(协调团队、规划、分配)、**worker**
  (执行具体任务)。这棵树**刻意不**映射到文件系统(避免深层嵌套路径地狱);它活在内存里,外加
  一份 `team-state.xml` 快照。
- **XML 是一等系统原语,用于压缩——而不只是传输。** agent 之间的回合是 XML(`<turn>` /
  `<agent_message>`),`ledger.xml` 记录完整执行历史并支持**回放**。关键在于:上下文变长时,内核
  把旧内容**折叠**进 `<compact>` 而非丢弃——你损失的是 token,不是记忆。
- **天生对提示缓存友好。** XML 布局把不变量(系统 + 历史回合)放在前面,每个新回合追加在尾部,
  因此一段长会话里 Anthropic prompt-cache 命中率始终很高——这是设计使然的更省更快,而非碰运气。
- **系统提示是组装出来的,不是写死的。** 它在运行时由优先级排序的 **Slot** 片段拼装:
  `soul(0) → framework-cognition(10) → core-principle(20) → memory(30) → environment(40) →
  skills(110) → tools(130) → context/todos(150) → subagents(200)`。人格、技能、工具按优先级插入,
  而非烤进一整条字符串。
- **实时操舵。** 一组 LLM-free 的 ScriptAgent 组成 **Gateway** 处理外部入口(WebSocket / HTTP),
  用 EventBus 的 `steer` 信号在回合进行中打断并重定向一个正在运行的 agent。

## 架构(src/)

| 区域 | 职责 |
|:--|:--|
| `tree` / `team` | 显式 AgentTree + 团队协调与 `team-state.xml` |
| `gateway` | LLM-free 的 ScriptAgent 入口(WS/HTTP)+ steer 信号 |
| `message` / `context-window` | XML 回合信封、可回放账本、压缩/折叠 |
| `capability`(`command` / `plugin` / `slot` / `tool`) | 可扩展的能力模型 |
| `llm` | 模型调用的 provider/driver 层 |
| `sandbox` | 基于容器的隔离(setup/recovery、fs-bridge、port-forwarder) |
| `session` / `registries` / `memory` / `hooks` | 会话生命周期、注册表、持久记忆、生命周期钩子 |
| `core` | 把一切串起来的内核循环 |

## 关键概念

`AgentTree`(router / admin / worker)· `team-state.xml`(树快照)· `<turn>` / `ledger.xml`
(XML 信封 + 可回放历史)· `<compact>`(折叠而非丢弃的压缩)· **Slot**(优先级排序的提示片段)
· **Gateway / ScriptAgent**(LLM-free 入口)· `steer`(实时打断)· capability = `command` /
`plugin` / `slot` / `tool`。

## 它如何融入 studio

当你在 Studio 里跟 **Forge** 聊天时,server 把这一回合交给这个内核。Forge(一个 admin)规划工作,
派出子 agent(worker)去调研、设计、编写引擎代码,结果经 XML 账本流回 UI——而你随时可以操舵。
由于内核在 server 进程内运行,没有额外的守护进程需要管理。

## 上手定位

正常使用下,内核由 studio 的 server 启动,而非手工运行。独立开发时,本包提供 `forgeax` 可执行文件
(`bin/forgeax`)以及 `start` / `dev` 脚本;每个 `src/<area>/README.md` 记录该子系统的契约。

---

本仓是 **ForgeaX Studio** 的一个子模块,隶属
[`ForgeaX-Games/forgeax-studio`](https://github.com/ForgeaX-Games/forgeax-studio) ——
用 `--recurse-submodules` 克隆超级仓即可运行完整 studio。许可:Apache-2.0。
