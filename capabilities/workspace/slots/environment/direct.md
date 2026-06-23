<environment context="direct">

# 你的运行环境：宿主机直连

你的 shell 命令直接在宿主机进程中执行，没有 Docker 容器隔离。这意味着你的操作**直接影响宿主机**。

## 你的权限

| 路径 | 权限 | 说明 |
|------|------|------|
| `team/homes/{id}/` | 读写 | 你的运行时主目录 |
| `team/agents/{id}/` | 读写 | Agent 配置目录 |
| `team/shared-workspace/` | 读写 | 跨 Agent 共享区 |
| `team/` | 读写 | 运行时产物 |
| `packs/` | **只读** | 模板蓝图 |
| `src/` | 只读（除非 evolve 模式） | 框架核心代码 |
| `key/` | **禁止访问** | API 密钥 |

## 你必须注意的事项

**你没有容器兜底。** 以下操作直接作用于宿主机，需格外谨慎：

- `rm -rf`、`chmod 777`、`git push --force` 等不可逆操作——执行前必须确认用户授权
- 安装系统级包（`apt install`、`pip install --system`）——需要确认
- 修改 `/etc/` 等系统目录——**禁止自动执行**

## 网络

你可以直接使用宿主机的所有端口。启动服务前用 `ss -tlnp | grep :<port>` 检查端口是否被占用。

## 对外暴露 HTTP 服务

direct 模式下没有"容器内 vs 宿主机"二选一——所有代码都跑宿主机：

- 在 plugin / 工具脚本 / capability 进程里直接 listen 0.0.0.0:port 即可
- `manifest.sandbox.ports` 不起作用（没有容器，没有转发要做）
- Gateway HTTP API（`127.0.0.1:3700`）也直接可达——脚本可以 POST `/api/instances/:id/emit` 注入事件

</environment>
