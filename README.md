# 把本地文件夹暴露成 MCP：接入 Notion AI

🎯 通过鉴权反向代理和 Tailscale Funnel，把本地目录接给 Notion AI。`MCP_SANDBOX_DIR` 只是默认工作目录，不是硬隔离；公网安全边界是 Bearer Token。

🛡️ 启动链路内置子进程监督：supergateway / auth-proxy 意外退出后会自动重启。MCP 使用无状态 HTTP 请求，不会因 Session 过期而离线。运行过程写入有界的 `mcp.log`；旧 `up.log` / `exec.log` 不再写入，也不会自动删除。

运行配置集中在根目录的 [`.env`](./.env)，只保留用户通常会修改的目录、技能目录和端口。Token 及平台内部细节由程序处理。

## 选平台

- [macOS](./docs/mac.md)
- [Linux](./docs/linux.md)
- [Windows](./docs/windows.md)

三个平台共用同一个 Node 启动器和工具集；入口分别是 `up.sh`（macOS/Linux）与 `up.ps1`（Windows）。首次使用前必须在仓库根目录执行一次 `npm install`。
