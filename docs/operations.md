# 运维与排障

## 升级与恢复

停止前台进程或用户服务后，拉取代码并执行 `npm install`。先运行 `npm test`，再运行 `node bin/notionmcp.mjs install --dry-run` 检查平台定义；确认后重新执行 `install`。

服务、Tailscale 或机器重启后，用户服务会重启 Node；带 `--bg` 的 Funnel 会恢复。运行：

```bash
npm run doctor
npm run status
```

`doctor` 的 JSON 分别给出 `local`、`funnel` 和可选 `public`。`public` 默认 `skipped`；只有显式传入 `--public-url` 才会向公网 `/mcp` 发送不带 Token 的请求，预期得到 `401`，这只证明路由可达。

## Notion 报“Failed to connect”

1. 运行 `npm run doctor`。`local` 不是 `ready` 时先检查 Node 服务；`funnel` 是 `not_logged_in` 时运行 `tailscale login`；`missing` 时运行 `npm start` 或重启用户服务。
2. 核对 Notion Custom Agent URL 末尾为 `/mcp`，鉴权方式是 Bearer，Token 是裸 64 位十六进制值。
3. 在 Notion Activity 中记下失败时间，并在 `mcp.log` 按同一分钟和 `traceId` 查找。客户端收到的 `X-Request-Id` 与日志 `traceId` 相同；日志不会记录 Token、请求 body、命令或文件内容。
4. `cancelled` 表示 Notion/代理关闭了本次响应，`rejected` 有 `reason` 与 HTTP 状态，`failed` 才表示服务内部异常。进程仍在线但偶发失败时，这些分类比“是否重启”更有用。

不要用 `tailscale funnel reset` 作为排障手段：它会影响非本项目 route。NotionMCP 只配置和卸载 `/mcp`。

## 演练

每次升级后依次执行：启动服务、`npm run doctor`、在 Notion 手工调用 `tools/list` 或开发工具、重启本机用户服务、再次 `doctor`。确认 `local.ready`、`funnel.ready`，并验证一次受控工具调用成功。
