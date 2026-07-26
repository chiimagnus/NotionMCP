# Windows

## 前置条件

安装 Node.js、Tailscale CLI 和 PowerShell。SVG 图片需要额外安装 ImageMagick（`magick`），位图图片不需要额外依赖。

把 `.env.example` 复制为 `.env`，至少设置：

```dotenv
MCP_SANDBOX_DIR_WINDOWS=~/AI-Share
MCP_SKILLS_DIR_WINDOWS=~/.codex/skills
```

## 一次性准备

```powershell
$ShareDir = "$env:USERPROFILE\AI-Share"
New-Item -ItemType Directory -Force -Path $ShareDir | Out-Null
"MCP connection test" | Out-File -Encoding utf8 (Join-Path $ShareDir "connection-test.txt")

$TokenDir = Join-Path $env:USERPROFILE ".mcp"
New-Item -ItemType Directory -Force -Path $TokenDir | Out-Null
$Token = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$Token | ConvertTo-SecureString -AsPlainText -Force |
    ConvertFrom-SecureString | Set-Content (Join-Path $TokenDir "token.enc")
```

`token.enc` 使用 Windows DPAPI，只能由当前 Windows 用户在当前机器上读取。Token 不要写进仓库、Notion 页面或聊天记录。

需要填入 Notion 时可临时读取裸 token（不要把输出保存进文件）：

```powershell
$secure = Get-Content (Join-Path $env:USERPROFILE ".mcp\token.enc") | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
```

如果 PowerShell 禁止执行脚本：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

## 启动

在仓库根目录执行：

```powershell
& .\up.ps1
```

`up.ps1` 会调用共享的 `up.mjs`，启动 8001 的 Supergateway、8000 的 Bearer 鉴权代理，并用 Tailscale Funnel 暴露 8000。它会自动检查 MCP initialize、鉴权和 Funnel 指向；端口冲突会直接失败，不会复用旧进程假装成功。

保持 PowerShell 窗口运行，按 `Ctrl + C` 停止。启动成功后，Notion 的 Server URL 使用：

```text
https://<你的设备名>.<你的tailnet名>.ts.net/mcp
```

鉴权方式选择 Bearer Token，填 `token.enc` 解出的裸 token。8001 不得暴露到公网。

## 工具差异

`run_command` 使用 Windows PowerShell；`read_image` 支持常见位图，SVG 需要 ImageMagick。`MCP_SANDBOX_DIR` 只是默认工作目录，不是严格沙盒。
