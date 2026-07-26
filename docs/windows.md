# Windows

## 前置条件

安装 Node.js、Tailscale CLI 和 PowerShell。SVG 图片需要额外安装 ImageMagick（`magick`），位图图片不需要额外依赖。

## 配置

在仓库根目录执行：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，至少设置：

```dotenv
MCP_SANDBOX_DIR_WINDOWS=~/AI-Share
MCP_SKILLS_DIR_WINDOWS=~/.codex/skills
```

## 一次性准备

### 1. 保存或更新 Token

```powershell
$TokenDir=Join-Path $env:USERPROFILE ".mcp"; New-Item -ItemType Directory -Force -Path $TokenDir | Out-Null; $Token=node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; $Token | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content (Join-Path $TokenDir "token.enc")
```

`token.enc` 使用 Windows DPAPI，只能由当前 Windows 用户在当前机器上读取。Token 不要写进仓库、Notion 页面或聊天记录。
可用下面命令检查 token 文件权限：

```powershell
icacls.exe (Join-Path $TokenDir "token.enc")
```

不要用 Administrator 运行服务，并建议开启 BitLocker。

需要填入 Notion 时可临时读取裸 token（不要把输出保存进文件）：

```powershell
$secure=Get-Content (Join-Path $env:USERPROFILE ".mcp\token.enc") | ConvertTo-SecureString; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
```

这里只为填入 Notion 临时输出 token；不要把输出保存到文件或提交到仓库。

如果 PowerShell 禁止执行脚本，先执行：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

## 启动

在仓库根目录打开 PowerShell，执行：

```powershell
& .\up.ps1
```

首次使用 Tailscale 时，在管理后台开启 HTTPS 证书和 Funnel 权限。不要暴露 8001。

看到下面的成功提示后，保持 PowerShell 窗口运行：

```text
✅ 8001 起来了
✅ 8000 起来了
✅ 鉴权生效（无 token → 401）
✅ Funnel 已指向 8000
```

按 `Ctrl + C` 停止。

## Notion 配置

Agent → **Add connection → Custom MCP server**

| 字段 | 填什么 |
| --- | --- |
| Server URL | `https://<你的设备名>.<你的tailnet名>.ts.net/mcp` |
| 鉴权方式 | **Bearer Token**，前缀选 `Bearer` |
| Token | 上一步解出的裸 token，不要再手动加 `Bearer` |
| 权限 | 按需选择 |

Token 泄露等价于允许公网调用当前用户可执行的命令；重要数据应另行备份。
