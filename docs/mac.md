# macOS

## 前置条件

安装 Node.js 20.11+ 和 Tailscale。

## 配置

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
security add-generic-password -U -a "$USER" -s mcp-token -w
```

把 Node 生成的 64 位十六进制字符串粘贴到钥匙串密码提示中，并编辑 `.env`：

```dotenv
MCP_PORT=8000
MCP_SANDBOX_DIR_MACOS=~/AI-Share
MCP_SKILLS_DIR_MACOS=~/.codex/skills
```

用启动器实际采用的查询条件验证读取：

```bash
security find-generic-password -a "$USER" -s mcp-token -w
```

该命令会直接输出裸 Token；只在自己的终端执行，不要复制到聊天或日志中。

第一次读取时在钥匙串弹窗中选择「始终允许」。Token 不要写进仓库、Notion 页面或聊天记录。

## 前台启动（首次验证）

```bash
npm install
npm start
```

看到 `MCP 已在 127.0.0.1:<端口>/mcp 启动`、`Funnel 仅暴露 MCP 路径：/mcp、/mcp/sse、/mcp/messages` 和完整的 `Notion MCP URL` 后，再继续配置 Notion。这个方式必须保持终端打开；按 `Control+C` 会停止服务并撤销本项目的 MCP Funnel paths。

`./up.sh` 与 `npm start` 等价，只是前者是旧的 shell 包装；日常使用 `npm start` 即可。

## 常驻运行（推荐）

确认前台启动成功，并在钥匙串提示中选择「始终允许」后，安装为**当前登录用户**的 LaunchAgent：

```bash
node bin/notionmcp.mjs install --dry-run
node bin/notionmcp.mjs install
```

第一条只展示将要写入的定义；第二条会写入 `~/Library/LaunchAgents/com.notionmcp.plist` 并立即启动。此后无需保留终端：每次登录 macOS 后会自动启动，进程意外退出时会自动重启。它不是系统级 daemon，因此在尚未登录该用户前不会运行。

检查常驻服务、MCP 本机监听和 Funnel：

```bash
launchctl print "gui/$(id -u)/com.notionmcp"
npm run doctor
npm run status
```

排查启动失败或 Notion 连接异常时，分别查看启动器输出和结构化诊断日志：

```bash
tail -f mcp-service.log
tail -f mcp.log
```

修改 `.env`、升级代码或需要手动重启时，重新执行安装命令即可；它会先卸载当前用户服务再以新定义启动：

```bash
npm install
node bin/notionmcp.mjs install
```

彻底停止并取消常驻：

```bash
node bin/notionmcp.mjs uninstall
```

服务只监听 `127.0.0.1:<端口>`；Tailscale Funnel 只公开 `/mcp`、`/mcp/sse` 和 `/mcp/messages`。启动器只管理这三条路径，不会 `tailscale funnel reset`，也不会删除其他 route；仅会清理旧版本指向该本机端口的 `/` 路由。

Notion 中选择 **Add connection → Custom MCP server**：

| 字段 | 值 |
| --- | --- |
| Server URL | `https://<设备名>.<tailnet名>.ts.net/mcp` |
| 鉴权方式 | Bearer Token |
| Token | 钥匙串中的裸值 |

Notion 的 Server URL 始终填写 `/mcp`。2025 Streamable HTTP 的独立 GET 会被服务以 `405 Allow: POST` 拒绝，避免无用长连接；Notion 的初始化和工具调用仍使用 POST。只有明确要求 2024 HTTP+SSE 地址的旧客户端才填写 `/mcp/sse`，不要把它用于 Notion。

排障见 [operations.md](./operations.md)。
