# 把 Mac 本地文件夹暴露成 MCP：接入 Notion AI 完整指南

> 🎯 把本地一个目录暴露成远程 MCP 服务器，接给 Notion AI。不开路由器端口、不给完整磁盘权限：沙盒目录 + 鉴权反向代理 + Tailscale Funnel。macOS 和 Windows 两版思路一致，具体步骤分在下面两份文档里。

## 选平台

- [mac.md](./mac.md)
- [windows.md](./windows.md)

## 源代码

2026.7.26 起 mac 版后端换成了 `exec-server.mjs`（`run_command`，能跑任意命令），`up.sh` 同步更新为启动它；`up.ps1` / Windows 版还是旧的 Filesystem 版本，尚未同步升级。exec-server.mjs 一开始升到 1.1.0，新增 `read_image` 工具；同一天晚些时候又拆成了多文件（1.2.0），一个工具一个文件，方便维护，行为完全不变：

- [`auth-proxy.mjs`](./auth-proxy.mjs) — 鉴权反向代理（macOS / Windows 共用）
- [`exec-server.mjs`](./exec-server.mjs) — MCP 入口：收发 JSON-RPC、按名字把调用分发给 `tools/` 里的工具
- [`lib/config.mjs`](./lib/config.mjs) — 共享常量（沙盒目录、超时上限、日志路径……）
- [`lib/rpc.mjs`](./lib/rpc.mjs) — 共享的 `send` / `log` / `truncate` 辅助函数
- [`lib/paths.mjs`](./lib/paths.mjs) — 路径解析辅助函数
- [`tools/run_command.mjs`](./tools/run_command.mjs) — `run_command` 工具（跑任意 shell 命令）
- [`tools/read_image.mjs`](./tools/read_image.mjs) — `read_image` 工具（读图片 / SVG 转 PNG 后返回）
- [`tools/index.mjs`](./tools/index.mjs) — 工具注册表，新增工具只需要在这里加一行
- [`up.sh`](./up.sh) — macOS 一键启动脚本
- [`up.ps1`](./up.ps1) — Windows 一键启动脚本（尚未同步升级到 exec-server 版）

这个文件夹本身就是 git 仓库。后续改代码或文档，直接改这里的文件、`git commit` 就行；如果还想保留 Notion 那份文档，记得手动同步，两边不会自动互相更新。

## 资料

[Notion 帮助：MCP connections for Custom Agents](https://www.notion.com/help/mcp-connections-for-custom-agents) · [Supergateway](https://github.com/supercorp-ai/supergateway) · [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) · [Tailscale CLI（含 Windows）](https://tailscale.com/docs/reference/tailscale-cli) · [Filesystem MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) · [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) · [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
