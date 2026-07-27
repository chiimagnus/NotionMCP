# 把本地文件夹接入 Notion AI

NotionMCP 是一个单进程、无 Session 的 MCP server：Node 在 `127.0.0.1` 提供带 Bearer Token 鉴权的 Streamable HTTP，Tailscale Funnel 只把这个本机端口暴露给 Notion。

`MCP_SANDBOX_DIR_*` 只是默认工作目录，不是硬隔离。Token 泄露等价于允许公网调用当前用户可执行的命令；重要数据必须另行备份。

## 使用

- [macOS](./docs/mac.md)
- [Linux](./docs/linux.md)
- [Windows](./docs/windows.md)

需要 Node.js 20.11 或更高版本。复制 `.env.example` 为 `.env`，填写当前平台配置，执行 `npm install`，再运行 `up.sh`（macOS/Linux）或 `up.ps1`（Windows）。

开发和故障诊断日志以 JSON Lines 写入有界的 `mcp.log`：保留服务生命周期、工具结果、错误消息、调用栈和失败 stderr 尾部，自动脱敏 Token，不记录完整命令、stdout、文件内容或请求正文。修改 `.env` 或增删 skill 后需要重启服务。

## 从旧版本迁移

把旧 `.env` 的 `MCP_PROXY_PORT` 改成 `MCP_PORT`，删除 `MCP_UPSTREAM_PORT`；外部 shell 中的通用 `MCP_SANDBOX_DIR` / `MCP_SKILLS_DIR` 改成当前平台专属 key。旧 `up.log` / `exec.log` 不再写入，可自行归档或删除，程序不会动用户历史文件。

默认启动器独占本设备的 Funnel 配置：正常关闭时会执行一次 `tailscale funnel reset`，这会清除本设备的其他 Funnel route。需要共享 route 时不要使用默认启动器，应自行编排 HTTP server 与 Funnel。异常断电或 `SIGKILL` 可能留下指向已关闭端口的 route，恢复时手工执行一次 `tailscale funnel reset`。

## 维护

提交前运行 `npm test`；涉及请求或进程生命周期时再运行 `npm run test:soak`。
