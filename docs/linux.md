# Linux

## 前置条件

安装 Node.js、Tailscale CLI 和 OpenSSL。SVG 图片需要额外安装 ImageMagick（`magick`/`convert`）或 librsvg（`rsvg-convert`），位图图片不需要额外依赖。

## 配置

在仓库根目录执行：

```bash
cp .env.example .env
```

编辑 `.env`，至少设置：

```dotenv
MCP_SANDBOX_DIR_LINUX=~/AI-Share
MCP_SKILLS_DIR_LINUX=~/.codex/skills
```

## 一次性准备

### 0. 安装依赖

```bash
npm install
```

这样 supergateway 会固定版本安装在本地 `node_modules` 里，每次启动不用再联网解析版本、也不会因为 registry 抖动而变慢或失败（不执行这一步也能跑，只是会自动回退到较慢、较不稳定的 `npx -y` 拉取方式）。

### 1. 保存 Token

```bash
mkdir -p "$HOME/.mcp"
umask 077
openssl rand -hex 32 > "$HOME/.mcp/token"
chmod 600 "$HOME/.mcp/token"
```

Token 不要写进仓库、Notion 页面或聊天记录。

### 2. 首次开通 Tailscale Funnel

首次使用时，在 Tailscale 管理后台开启 HTTPS 证书和 Funnel 权限。只允许 Funnel 指向 8000。

## 启动

```bash
chmod +x ./up.sh
./up.sh
```

保持终端运行，按 `Ctrl + C` 停止。不要暴露 8001。supergateway 或 auth-proxy 中途意外退出时，启动器会自动按退避策略重启，不需要手动重新执行 `up.sh`；每 6 小时也会主动回收重启一次以避免长时间运行的会话/进程积累（可以在 `.env` 里设置 `MCP_RECYCLE_INTERVAL_MS` 调整间隔或设为 `0` 关闭）。运行过程会持久化写入仓库根目录的 `up.log`，排查问题时可以先看这个文件。启动成功后，在 Notion 中填写：

| 字段 | 填什么 |
| --- | --- |
| Server URL | `https://<你的设备名>.<你的tailnet名>.ts.net/mcp` |
| 鉴权方式 | **Bearer Token**，前缀选 `Bearer` |
| Token | `~/.mcp/token` 里的裸 token，不要再手动加 `Bearer` |
| 权限 | 按需选择 |

Token 泄露等价于允许公网调用当前用户可执行的命令；重要数据应另行备份。
