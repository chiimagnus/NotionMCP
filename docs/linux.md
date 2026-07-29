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

## 启动与常驻

```bash
npm install
chmod +x ./up.sh
./up.sh
```

前台运行时按 `Ctrl+C` 正常停止。服务只监听 `127.0.0.1:8000`；Funnel 只公开 `/mcp`。修改 `.env` 后重启。

安装为 systemd user service：

```bash
node bin/notionmcp.mjs install --dry-run
node bin/notionmcp.mjs install
systemctl --user status notionmcp.service
node bin/notionmcp.mjs uninstall
```

Notion 中选择 **Add connection → Custom MCP server**：

| 字段 | 值 |
| --- | --- |
| Server URL | `https://<设备名>.<tailnet名>.ts.net/mcp` |
| 鉴权方式 | Bearer Token |
| Token | `.env` 中 `MCP_TOKEN_LINUX` 的裸值 |

启动器只管理 `/mcp`，不会 reset 或影响其他 Funnel route。服务会自动重启；具体排障见 [operations.md](./operations.md)。
