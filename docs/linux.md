# Linux

## 前置条件

安装 Node.js 和 Tailscale CLI。SVG 图片需要额外安装 ImageMagick（`magick`/`convert`）或 librsvg（`rsvg-convert`），位图图片不需要额外依赖。

## 配置

在仓库根目录执行：

```bash
cp .env.example .env
```

编辑 `.env`，至少设置：

```dotenv
MCP_SANDBOX_DIR_LINUX=~/AI-Share
MCP_SKILLS_DIR_LINUX=~/.codex/skills
MCP_TOKEN_LINUX=请替换为随机生成的64位十六进制字符串
```

`.env` 已被 Git 忽略，但其中的 Token 是明文；不要提交、分享或复制到其他文件。

## 一次性准备

### 0. 安装依赖

```bash
npm install
```

启动器只使用本地安装并由 `package-lock.json` 锁定的 supergateway；缺少依赖时会直接报错，不再临时联网下载另一份。

### 1. 生成 Token

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

把输出同时填入 `.env` 的 `MCP_TOKEN_LINUX` 和 Notion 的 Token 字段。

### 2. 首次开通 Tailscale Funnel

首次使用时，在 Tailscale 管理后台开启 HTTPS 证书和 Funnel 权限。只允许 Funnel 指向 8000。

## 启动

```bash
chmod +x ./up.sh
./up.sh
```

保持终端运行，按 `Ctrl + C` 停止。不要暴露 8001。supergateway 或 auth-proxy 中途意外退出时，启动器会每 5 秒重试，不需要手动重新执行 `up.sh`。MCP 使用无状态 HTTP 请求，不会因 Session 过期而离线。运行过程写入仓库根目录的 `up.log`。启动成功后，在 Notion 中填写：

| 字段 | 填什么 |
| --- | --- |
| Server URL | `https://<你的设备名>.<你的tailnet名>.ts.net/mcp` |
| 鉴权方式 | **Bearer Token**，前缀选 `Bearer` |
| Token | `.env` 中 `MCP_TOKEN_LINUX` 的值，不要再手动加 `Bearer` |
| 权限 | 按需选择 |

Token 泄露等价于允许公网调用当前用户可执行的命令；重要数据应另行备份。
