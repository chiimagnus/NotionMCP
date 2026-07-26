# macOS

## 前置条件

安装 Node.js、Tailscale 和 OpenSSL。

## 配置

在仓库根目录执行：

```bash
cp .env.example .env
```

编辑 `.env`，通常只需要修改 `MCP_SANDBOX_DIR_MACOS` 和 `MCP_SKILLS_DIR_MACOS`；端口冲突时再调整 `MCP_PROXY_PORT` 和 `MCP_UPSTREAM_PORT`。

## 一次性准备

### 1. 把 Token 存进钥匙串

```bash
openssl rand -hex 32
security add-generic-password -a "$USER" -s mcp-token -w
security find-generic-password -a "$USER" -s mcp-token -w
```

将生成的 token 粘贴到 `security add-generic-password` 的密码提示中。
第一次读取时点钥匙串弹窗里的「始终允许」。Token 不要写进仓库、Notion 页面或聊天记录。

### 2. 首次开通 Tailscale Funnel

首次使用时，在 Tailscale 管理后台开启 HTTPS 证书和 Funnel 权限。只允许 Funnel 指向 8000；不要暴露 8001。

## 启动

仓库根目录执行：

```bash
chmod +x ./up.sh
./up.sh
```

看到下面的成功提示后，保持终端运行：

```text
✅ 8001 起来了
✅ 8000 起来了
✅ 鉴权生效（无 token → 401）
✅ Funnel 已指向 8000
```

按 `Control + C` 停止。若上次异常退出后 Funnel 仍在运行，执行：

```bash
tailscale funnel reset
```

## Notion 配置

Agent → **Add connection → Custom MCP server**

| 字段 | 填什么 |
| --- | --- |
| Server URL | `https://<你的设备名>.<你的tailnet名>.ts.net/mcp` |
| 鉴权方式 | **Bearer Token**，前缀选 `Bearer` |
| Token | 钥匙串里的裸 token，不要再手动加 `Bearer` |
| 权限 | 按需选择 |
