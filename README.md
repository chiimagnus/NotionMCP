# 把本地文件夹接入 Notion AI

NotionMCP 是无 Session 的 MCP server：兼容 MCP `2025-03-26` 与 `2026-07-28`，Node 只监听 `127.0.0.1`，Tailscale Funnel 只公开 `/mcp`。每次请求都有脱敏 `X-Request-Id`，本机 `/healthz` 不经 Funnel 公开。

`MCP_SANDBOX_DIR_*` 只是默认工作目录，不是硬隔离。Token 泄露等价于允许公网调用当前用户可执行的命令；重要数据必须另行备份。

## 使用

- [macOS](./docs/mac.md)
- [Linux](./docs/linux.md)
- [Windows](./docs/windows.md)

需要 Node.js 20.11+ 与 Tailscale。复制 `.env.example` 为 `.env`、填写当前平台配置后执行 `npm install`。

常用命令：

```bash
npm start                 # 前台启动
npm run status            # Funnel /mcp 配置状态（JSON）
npm run doctor            # 本机 health + Funnel 诊断（JSON）
npm run doctor -- --public-url https://<设备名>.<tailnet名>.ts.net/mcp
node bin/notionmcp.mjs install --dry-run
```

完整的安装、升级、恢复与 Notion Activity 排障见 [运维手册](./docs/operations.md)。
