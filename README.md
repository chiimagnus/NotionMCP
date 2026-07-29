# 把本地文件夹接入 Notion AI

NotionMCP 是无 Session 的 MCP server：只支持 MCP `2026-07-28`，Node 只监听 `127.0.0.1`，Tailscale Funnel 只公开 `/mcp`。每次请求都有脱敏 `X-Request-Id`，本机 `/healthz` 不经 Funnel 公开。

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

## Notion Custom Agent 配置

在 Custom Agent 的 `Settings → Tools & Access` 中连接 `https://<你的设备>.<tailnet>.ts.net/mcp`，按工具单独启用：

- 设为“自动运行”：`project_context`、`load_skills`、`read_file`、`read_image`。
- 设为“始终询问”：`run_command`、`apply_patch`。前者可以执行任意命令，后者会修改文件；不要选择服务器级的永久允许。

Notion 官方将 read 工具建议为自动运行、write 工具建议为每次确认；也支持在连接内逐个开关工具。[官方连接与审批说明](https://www.notion.com/help/mcp-connections-for-custom-agents)

推荐给 Agent 的工作顺序：`project_context`（规则与所有 skills 摘要）→ （需要时）`load_skills` → `read_file`/`read_image` → `run_command` 诊断 → `apply_patch` 修改 → `run_command` 验证。规则或 skills 的正文只会在相应读取工具结果中出现。
