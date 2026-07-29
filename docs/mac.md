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

## 启动与常驻

```bash
npm install
chmod +x ./up.sh
./up.sh
```

前台运行时按 `Control+C` 正常停止。服务只监听 `127.0.0.1:8000`；Funnel 只公开 `/mcp`。修改 `.env` 后重启。

安装为当前用户的 launchd 服务（先检查输出，不写任何系统状态）：

```bash
node bin/notionmcp.mjs install --dry-run
node bin/notionmcp.mjs install
node bin/notionmcp.mjs uninstall
```

Notion 中选择 **Add connection → Custom MCP server**：

| 字段 | 值 |
| --- | --- |
| Server URL | `https://<设备名>.<tailnet名>.ts.net/mcp` |
| 鉴权方式 | Bearer Token |
| Token | 钥匙串中的裸值 |

启动器只管理 `/mcp`；不会 `tailscale funnel reset`，也不会删除其他 route。旧版本项目根路由仅在目标精确匹配本机端口时迁移。排障见 [operations.md](./operations.md)。
