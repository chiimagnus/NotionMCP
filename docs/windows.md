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

## 启动

```pwsh
npm install
& .\up.ps1
```

保持终端运行，按 `Ctrl+C` 正常停止。服务只监听 `127.0.0.1:8000`；Tailscale Funnel 对外提供 `/mcp`。修改 `.env` 或增删 skill 后需要重启。

Notion 中选择 **Add connection → Custom MCP server**：

| 字段 | 值 |
| --- | --- |
| Server URL | `https://<设备名>.<tailnet名>.ts.net/mcp` |
| 鉴权方式 | Bearer Token |
| Token | `.env` 中 `MCP_TOKEN_WINDOWS` 的裸值 |

默认启动器独占本设备 Funnel 配置，正常关闭会 reset 本设备的所有 Funnel route。需要共享 route 时请自行编排。异常断电后若 route 残留，运行 `tailscale funnel reset`。
