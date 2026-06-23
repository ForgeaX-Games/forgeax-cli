<environment context="docker">

# 你的运行环境：Docker 沙箱

你的 shell 命令在容器内执行；read_file / edit_file / write_file 也桥接到容器文件系统。这些是**当前环境**特化的操作行为——AGENTIC.md 只描述不变的进程归属事实。

## 沙箱模式速览

由 `pack.json` 的 `sandbox.mode` 声明，运行时不可改：

| 模式 | 容器特征 | 用途 |
|------|----------|------|
| `direct` | 无 Docker，shell 直接在宿主机 | 开发调试（你看到的不是这档） |
| `headless` | 轻量 CLI 容器（node + python + git + sshfs） | 日常使用 |
| `desktop` | GUI 容器（VNC + 浏览器 + CJK 字体 + xdotool） | 需要图形界面 |

## 镜像预装组件（不要重复安装）

| 组件 | 说明 |
|------|------|
| KasmVNC (`Xkasmvnc`) | 集成 X server + WebSocket VNC，随容器启动自动起。默认 display `:1`、websocket 端口 `6901`，`-DisableBasicAuth`无密码（仅 desktop 档）|
| Xfce4 + dbus + PulseAudio | 桌面会话（仅 desktop 档）|
| 中日韩字体 + Emoji | fonts-noto-cjk、wqy-zenhei、noto-color-emoji |
| python3 / pip / git / curl / wget | 常用系统工具 |
| imagemagick / scrot / xdotool | 截图与窗口自动化（仅 desktop 档） |

## 文件系统与工具路由

所有文件工具（`read_file` / `write_file` / `edit_file` / `grep` / `glob` / `lsp` 等）都走 **fs-bridge 统一路由**——你不需要关心路径在宿主机还是容器，框架自动判断：

- **项目根目录下的路径**（`team/`、`src/`、`capabilities/` 等）→ 直接读写宿主机（bind-mount 同路径，零延迟）
- **容器独有路径**（如 `/tmp/`、`/home/you/` 等）→ 通过 docker exec 桥接
- `key/` 被 tmpfs 遮盖——容器内**无法读取 API 密钥文件**
- 项目源码以只读方式挂入——你无法修改 `src/` / `capabilities/` 下的框架代码（除非 evolve 模式）

**访问宿主机上项目根以外的目录**（如用户要你读 `/data/projects/foo/`）：默认不可达——需要先在 `mounts.json` 中配置 SSHFS 挂载，将宿主机路径映射到容器内。详见 AGENTIC.md §8（动态路径挂载）。

## 网络的隐藏限制

容器跟宿主机之间有一些**默认的不可达性**，不知道会踩坑：

- **Gateway HTTP API 监听 `127.0.0.1:3700`** —— 容器内通过 `host.docker.internal:3700` 不可达（Gateway 绑的是宿主机回环，不是 docker 网桥接口）
  - 后果：容器内服务想 publish EventBus 事件，**不能直接 POST `/api/instances/:id/emit`**
  - 解决：通过共享文件 + admin plugin 的 FSWatcher 桥接（详见下面"两条路"的路 B）
- **`key/` tmpfs 隔离** —— 容器内代码无法读 API 密钥
  - 后果：容器内进程想调 LLM API（OpenAI / Azure / Anthropic）必须通过 EventBus 让宿主机进程代发
- **检查端口**：在容器内用 `ss -tlnp` 看监听情况；看不到 plugin 起的服务端口，因为那些跑在宿主机进程里

## 对外暴露 HTTP 服务（两条路）

需要让浏览器/外部访问到一个 HTTP 服务时，有两条独立的路，**按场景选**：

### 路 A：在 admin / 其他 agent 的 plugin 里直接 listen

```ts
// admin 的 capabilities/{package}/plugins/foo.ts
const server = http.createServer(handler);
server.listen(port, "0.0.0.0", () => { /* ... */ });
```

- 物理位置：plugin 跑在**宿主机进程内**，端口直接绑宿主机网卡
- 直接拿 `ctx.eventBus` / `ctx.pathManager` / 其他框架 API
- 跟 capability 强绑定（生命周期、配置都跟 owner agent 一致）
- **不需要** `manifest.sandbox.ports`——端口直接在宿主机上
- 配置点：plugin 自己的 config（`agent.json` 的 `capabilities.config.{package}.{plugin}`）

适合：业务前端 / 跟 EventBus 紧耦合的服务 / agent 给团队的接入口

### 路 B：容器内服务 + manifest.sandbox.ports + socat 转发

```bash
# 在容器内启动服务
python3 server.py --listen 0.0.0.0:8080
```

```jsonc
// manifest.json
{ "sandbox": { "ports": [8080] } }
```

- 物理位置：服务进程在**容器内**
- Gateway 自动 socat 转发：宿主机 `0.0.0.0:hostPort` → 容器 `:containerPort`（hostPort 默认尝试等于 containerPort，冲突时递增）
- **不能直接用 ctx.eventBus**——容器内代码无法访问 Gateway HTTP API（见上"网络的隐藏限制"）
- 跨界回调（容器服务 → 宿主机 EventBus）必须用文件桥（写 `shared-workspace/...` + 宿主机 plugin 的 FSWatcher 监听）

适合：跟 EventBus 无关的纯计算服务 / 第三方 server 已经写好（python/node 项目）/ 不可信代码需要容器隔离

### 决策树

| 场景 | 选 |
|---|---|
| 需要把 EventBus 事件桥到 HTTP（双向） | A |
| 业务方/团队前端，跟 admin 强绑定 | A |
| 不可信代码 / 重型隔离需求 | B |
| 现成的容器内 server（python/node） | B |
| 既要 EventBus 又要容器隔离 | B + plugin 文件桥 |

### sandbox.ports 的小细节

- 修改 `manifest.json` 的 `sandbox.ports` 数组后，FSWatcher 触发热更新——Gateway 自动调整端口映射，**无需重启 Instance**
- socat 监听 `0.0.0.0:hostPort`——团队/局域网都能访问，没有内置认证
- 容器服务监听 `0.0.0.0` 才能被转发命中（不要绑 `127.0.0.1`）

## GUI 应用（仅 desktop 档）

如果你需要运行浏览器或其他图形界面程序：

KasmVNC 随容器启动自动起，无需手动调用启动脚本。要跑 GUI 应用：

1. `export DISPLAY=:1`（`start-desktop.sh` 已默认设置，手动 spawn 子进程时才需重复）
2. 启动应用（如 `chromium --no-sandbox --disable-gpu`）

用户通过浏览器 / VNC 客户端连接 KasmVNC 查看桌面。默认 websocket 端口 `6901` （实际值以 manifest.json 为准）需要在 `manifest.sandbox.ports` 里声明才能从外部访问。

</environment>
