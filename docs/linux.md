# Linux

## 前置条件

安装 Node.js、Tailscale CLI 和 OpenSSL。SVG 图片需要额外安装 ImageMagick（`magick`/`convert`）或 librsvg（`rsvg-convert`），位图图片不需要额外依赖。

把 `.env.example` 复制为 `.env`，至少设置：

```dotenv
MCP_SANDBOX_DIR_LINUX=~/AI-Share
MCP_SKILLS_DIR_LINUX=~/.codex/skills
```

## 一次性准备

```bash
SHARE_DIR="$HOME/AI-Share"
mkdir -p "$SHARE_DIR"
printf 'MCP connection test\n' > "$SHARE_DIR/connection-test.txt"

mkdir -p "$HOME/.mcp"
umask 077
openssl rand -hex 32 > "$HOME/.mcp/token"
chmod 600 "$HOME/.mcp/token"
```

启动器会拒绝权限宽于 `600` 的 token 文件。Token 不要写进仓库、Notion 页面或聊天记录。

## 启动

```bash
chmod +x ./up.sh
./up.sh
```

`up.sh` 会启动 8001 的 Supergateway、8000 的 Bearer 鉴权代理，并用 Tailscale Funnel 暴露 8000。它会自动检查 MCP initialize、鉴权和 Funnel 指向；端口冲突会直接失败，不会复用旧进程假装成功。

保持终端运行，按 `Ctrl + C` 停止。启动成功后，Notion 的 Server URL 使用：

```text
https://<你的设备名>.<你的tailnet名>.ts.net/mcp
```

鉴权方式选择 Bearer Token，填 `~/.mcp/token` 里的裸 token。8001 不得暴露到公网。

## 工具差异

`run_command` 使用 `/bin/sh`；`read_image` 支持常见位图，SVG 需要 ImageMagick 或 librsvg。`MCP_SANDBOX_DIR` 只是默认工作目录，不是严格沙盒。
