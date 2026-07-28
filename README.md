# 把本地文件夹接入 Notion AI

NotionMCP 是一个单进程、无 Session 的 MCP server：Node 在 `127.0.0.1` 提供带 Bearer Token 鉴权的 Streamable HTTP，Tailscale Funnel 只把这个本机端口暴露给 Notion。

`MCP_SANDBOX_DIR_*` 只是默认工作目录，不是硬隔离。Token 泄露等价于允许公网调用当前用户可执行的命令；重要数据必须另行备份。

## 使用

- [macOS](./docs/mac.md)
- [Linux](./docs/linux.md)
- [Windows](./docs/windows.md)

需要 Node.js 20.11 或更高版本。复制 `.env.example` 为 `.env`，填写当前平台配置，执行 `npm install`，再运行 `up.sh`（macOS/Linux）或 `up.ps1`（Windows）。
