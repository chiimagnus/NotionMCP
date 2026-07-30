# Linux

## 前置条件

安装 Node.js 20.11+ 和 Tailscale CLI。SVG 需要 ImageMagick（`magick` / `convert`）或 librsvg（`rsvg-convert`）；位图不需要额外工具。

## 配置

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

编辑 `.env`：

```dotenv
MCP_PORT=8000
MCP_SANDBOX_DIR_LINUX=~/AI-Share
MCP_SKILLS_DIR_LINUX=~/.codex/skills
MCP_TOKEN_LINUX=粘贴刚生成的64位十六进制字符串
```

`.env` 已被 Git 忽略，但 Token 是明文；不要提交或分享。把同一个裸 Token 填入 Notion，不要手动添加 `Bearer`。

## 前台启动（首次验证）

```bash
npm install
npm start
```

看到 `MCP 已在 127.0.0.1:<端口>/mcp 启动`、`Funnel 仅暴露 MCP 路径：/mcp、/mcp/sse、/mcp/messages` 和完整的 `Notion MCP URL` 后，再继续配置 Notion。这个方式必须保持终端打开；按 `Ctrl+C` 会停止服务并撤销本项目的 MCP Funnel paths。

`./up.sh` 与 `npm start` 等价，只是旧的 shell 包装；日常使用 `npm start` 即可。

## 常驻运行（推荐）

确认前台启动成功后，安装为当前用户的 systemd service：

```bash
node bin/notionmcp.mjs install --dry-run
node bin/notionmcp.mjs install
```

第一条只展示将要写入的定义；第二条会写入 `~/.config/systemd/user/notionmcp.service`、重载 user-systemd 并立刻启动。服务进程意外退出后会在 3 秒后自动重启。

默认它会随该用户的 systemd 会话运行。若要在注销后保持运行，并在开机后登录前启动，再额外启用 linger：

```bash
loginctl enable-linger "$USER"
```

检查常驻服务、MCP 本机监听和 Funnel：

```bash
systemctl --user status notionmcp.service
npm run doctor
npm run status
```

排查启动失败或 Notion 连接异常时，分别查看 user-systemd 日志和结构化诊断日志：

```bash
journalctl --user -u notionmcp.service -f
tail -f mcp.log
```

修改 `.env` 或升级代码后，重启当前用户服务：

```bash
npm install
systemctl --user restart notionmcp.service
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
| Token | `.env` 中 `MCP_TOKEN_LINUX` 的裸值 |

Notion 的 Server URL 始终填写 `/mcp`。2025 Streamable HTTP 的独立 GET 会被服务以 `405 Allow: POST` 拒绝，避免无用长连接；Notion 的初始化和工具调用仍使用 POST。只有明确要求 2024 HTTP+SSE 地址的旧客户端才填写 `/mcp/sse`，不要把它用于 Notion。

具体排障见 [operations.md](./operations.md)。
