# Windows

## 前置条件

安装 Node.js、PowerShell 7、Tailscale CLI。SVG 图片需要额外安装 ImageMagick（`magick`），位图图片不需要额外依赖。

## 配置

在仓库根目录执行：

```pwsh
Copy-Item .env.example .env
```

编辑 `.env`，至少设置：

```dotenv
MCP_SANDBOX_DIR_WINDOWS=~/AI-Share
MCP_SKILLS_DIR_WINDOWS=~/.codex/skills
```

## 一次性准备

### 0. 安装依赖

```pwsh
npm install
```

启动器只使用本地安装并由 `package-lock.json` 锁定的 supergateway；缺少依赖时会直接报错，不再临时联网下载另一份。

### 1. 保存或更新 Token

```pwsh
$TokenDir=Join-Path $env:USERPROFILE ".mcp"; New-Item -ItemType Directory -Force -Path $TokenDir | Out-Null; $Token=node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; $Token | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content (Join-Path $TokenDir "token.enc")
```

`token.enc` 使用 Windows DPAPI，只能由当前 Windows 用户在当前机器上读取。Token 不要写进仓库、Notion 页面或聊天记录。
可用下面命令检查 token 文件权限：

```pwsh
icacls.exe (Join-Path $TokenDir "token.enc")
```

不要用 Administrator 运行服务，并建议开启 BitLocker。

需要填入 Notion 时可临时读取裸 token（不要把输出保存进文件）：

```pwsh
$secure=Get-Content (Join-Path $env:USERPROFILE ".mcp\token.enc") | ConvertTo-SecureString; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
```

这里只为填入 Notion 临时输出 token；不要把输出保存到文件或提交到仓库。

如果 PowerShell 7 禁止执行脚本，先执行：

```pwsh
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

## 启动

在仓库根目录打开 PowerShell 7（`pwsh`），执行：

```pwsh
& .\up.ps1
```

首次使用 Tailscale 时，在管理后台开启 HTTPS 证书和 Funnel 权限。不要暴露 8001。

看到下面的成功提示后，保持 PowerShell 7 窗口运行：

```text
✅ 8001 起来了
✅ 8000 起来了
✅ 鉴权生效（无 token → 401）
✅ Funnel 已指向 8000
```

按 `Ctrl + C` 停止。

supergateway 或 auth-proxy 中途意外退出时，启动器会每 5 秒重试，不需要手动重新执行 `up.ps1`。stdio 会话关闭时，其 exec-server 会自行退出；不再定时重启整条服务。运行过程写入仓库根目录的 `up.log`。

## Notion 配置

Agent → **Add connection → Custom MCP server**

| 字段 | 填什么 |
| --- | --- |
| Server URL | `https://<你的设备名>.<你的tailnet名>.ts.net/mcp` |
| 鉴权方式 | **Bearer Token**，前缀选 `Bearer` |
| Token | 上一步解出的裸 token，不要再手动加 `Bearer` |
| 权限 | 按需选择 |

Token 泄露等价于允许公网调用当前用户可执行的命令；重要数据应另行备份。
