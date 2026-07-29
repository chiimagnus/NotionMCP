# Windows

## 前置条件

安装 Node.js 20.11+、PowerShell 7 和 Tailscale CLI。SVG 需要 ImageMagick（`magick`）；位图不需要额外工具。

## 配置

```pwsh
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

编辑 `.env`：

```dotenv
MCP_PORT=8000
MCP_SANDBOX_DIR_WINDOWS=~/AI-Share
MCP_SKILLS_DIR_WINDOWS=~/.codex/skills
MCP_TOKEN_WINDOWS=粘贴刚生成的64位十六进制字符串
```

`.env` 已被 Git 忽略，但 Token 是明文；不要提交或分享。把同一个裸 Token 填入 Notion，不要手动添加 `Bearer`。

## 前台启动（首次验证）

```pwsh
npm install
& .\up.ps1
```

看到 `MCP 已在 127.0.0.1:<端口>/mcp 启动`、`Funnel 仅暴露 MCP 路径：/mcp、/mcp/sse、/mcp/messages` 和完整的 `Notion MCP URL` 后，再继续配置 Notion。这个方式必须保持终端打开；按 `Ctrl+C` 会停止服务并撤销本项目的 MCP Funnel paths。

`up.ps1` 会先验证 PowerShell 7 与 Node；若已经确认环境，也可执行 `npm start`。

## 常驻运行（推荐）

确认前台启动成功后，创建当前用户登录时运行的 Scheduled Task：

```pwsh
node bin/notionmcp.mjs install --dry-run
node bin/notionmcp.mjs install
schtasks.exe /Run /TN NotionMCP
```

第一条只展示将要写入的定义；第二条会写入项目中的 `.notionmcp/notionmcp-task.xml` 并创建任务。任务会在下次登录时自动启动，异常退出时每分钟最多重试一次；`/Run` 用于在**当前**已登录会话立即启动它。

检查任务、MCP 本机监听和 Funnel：

```pwsh
schtasks.exe /Query /TN NotionMCP /FO LIST /V
npm run doctor
npm run status
```

排查启动失败或 Notion 连接异常时，先看任务的 `Last Run Result`，再跟踪结构化诊断日志：

```pwsh
Get-Content -Wait .\mcp.log
```

修改 `.env` 或升级代码后，结束旧实例再运行任务。若任务尚未启动，跳过 `/End`：

```pwsh
npm install
schtasks.exe /End /TN NotionMCP
schtasks.exe /Run /TN NotionMCP
```

彻底停止并取消常驻：

```pwsh
node bin/notionmcp.mjs uninstall
```

服务只监听 `127.0.0.1:<端口>`；Tailscale Funnel 只公开 `/mcp`、`/mcp/sse` 和 `/mcp/messages`。启动器只管理这三条路径，不会 `tailscale funnel reset`，也不会删除其他 route。

Notion 中选择 **Add connection → Custom MCP server**：

| 字段 | 值 |
| --- | --- |
| Server URL | `https://<设备名>.<tailnet名>.ts.net/mcp` |
| 鉴权方式 | Bearer Token |
| Token | `.env` 中 `MCP_TOKEN_WINDOWS` 的裸值 |

Notion 的 Server URL 始终填写 `/mcp`。服务会兼容 Notion 当前的 2025 GET 通知流；只有明确要求 2024 HTTP+SSE 地址的旧客户端才填写 `/mcp/sse`，不要把它用于 Notion。

排障见 [operations.md](./operations.md)。
