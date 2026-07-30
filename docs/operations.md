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

不要用 `tailscale funnel reset` 作为排障手段：它会影响非本项目 route。NotionMCP 只配置和卸载自己的三条 MCP 路径：`/mcp`、`/mcp/sse` 与 `/mcp/messages`。启动时若发现旧版本遗留的 `/ -> http://127.0.0.1:<MCP_PORT>`，会先精确移除；若 `/` 指向其他目标，启动会拒绝接管，需先由该 route 的所有者处理。

## 并发状态与日志

在运行服务的电脑上查看健康状态（该端点只允许 loopback，不能从 Funnel 访问）：

```bash
curl http://127.0.0.1:8000/healthz
```

默认容量可在 `.env` 调校，改完后重启服务：

```dotenv
MCP_MAX_ACTIVE_REQUESTS=10
MCP_MAX_QUEUED_REQUESTS=64
MCP_MAX_SSE_STREAMS=256
```

`activeRequests` 是正在执行的 MCP 请求，`queuedRequests` 是 FIFO 等待数；它们分别不能超过对应的 `max...` 字段。`connections.legacySse` 是显式 2024 HTTP+SSE 会话，`totalSse` 与 `sseHighWater` 只统计这类旧会话。达到 `maxSseStreams` 或 `maxQueuedRequests` 时，只会拒绝**新**连接/请求，并返回 `Retry-After: 1`；已建立 legacy SSE 不会被服务主动踢掉。

`/mcp` 的独立 GET 会在鉴权后返回 `405 Allow: POST`。这是 2025 Streamable HTTP 对“不提供服务器主动消息流”的标准行为；Notion 的初始化、工具列表与工具调用仍全部通过 POST 完成。这样不会为每个 Notion 调用留下无业务用途的长期 SSE。

按失败时间筛选 `mcp.log` 的 JSON 行：

- 没有对应的 `received`：请求没有到 Node；先查 Notion、Funnel/Tailscale 和网络，不要重启仍健康的 Node。
- `received` 后出现 `rejected`：看 `status` 和 `reason`；`sse_capacity_reached` 是新 SSE 已到上限，`request_queue_full` 是 FIFO 已满，`unauthorized`/`origin_not_allowed` 是鉴权或来源问题。
- 同一 `traceId` 依次出现 `authenticated`、`queued`、`started`、`completed`：请求已正常到达、等待并完成。不同 `traceId` 交错是并发的正常表现，不代表服务重启。
- `cancelled`：客户端或代理在响应完成前断开；`failed`：Node 已收到请求但内部处理异常；工具自身错误则看 `scope:"tool"` 的 `failed`。
- `sse_opened` / `sse_closed` 配合 `legacySseSessions` 用于确认 2024 会话是否成对回收；日志只记录本地序号，不记录 SSE session ID、Token、请求 body、命令或文件内容。

## 两轮 12 条真实 Notion 复测

本地测试不能替代此验收。升级并重启常驻服务后，先确认 `npm run doctor` 的 `local`、`funnel` 都是 `ready`，并在本机另开终端执行 `tail -f mcp.log` 与上面的 `/healthz` 查询。`/healthz` 中不得再有 `streamableSse` 字段；正常 Notion 使用也不应让 `legacySse` 增长。`tailscale funnel status --json` 的本项目 host 不应存在 `/` handler。

1. 在 Notion 中让 AI **并行**发起 12 次独立 `run_command`，每次运行跨平台 Node 命令 `node -e "setTimeout(() => console.log('batch-1'), 4000)"`；等全部结束。
2. 不重启 MCP，立刻用相同方式再并行发起 12 次，把输出改为 `batch-2`。
3. 每批预期 12 条都完成。日志应有各自的 `received` 和 `completed`；高峰时 `activeRequests` 最多为 10，第二条及以后批次可短暂出现 `queuedRequests`，结束后必须回到 0。若 Notion 实际没有并发调度 12 条，以日志中的峰值为准，重新明确要求其并行调用。
4. 若 Notion 再报连接错误，按上一节先判断该失败时间是否存在 `received`，再保留对应 `traceId`、health 快照和 Funnel 状态作为证据。没有 `received` 时，不应把它归因为命令、队列或 Node 重启。

## 演练

每次升级后依次执行：启动服务、`npm run doctor`、在 Notion 手工调用 `tools/list` 或开发工具、重启本机用户服务、再次 `doctor`。确认 `local.ready`、`funnel.ready`，并验证一次受控工具调用成功；并发相关改动还要完成上面的两轮 12 条真实复测。
