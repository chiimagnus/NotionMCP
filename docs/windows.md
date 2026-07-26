# Windows

启动逻辑由共享的 `lib/up.mjs` 提供，Windows 入口是 `up.ps1`。配置、端口和 Notion 连接方式与其他平台相同，命令使用 PowerShell。

## 前置条件

安装 Node.js、Tailscale CLI 和 PowerShell。SVG 图片需要额外安装 ImageMagick（`magick`），位图图片不需要额外依赖。

## 配置

把 `.env.example` 复制为 `.env`，至少设置：

```dotenv
MCP_SANDBOX_DIR_WINDOWS=~/AI-Share
MCP_SKILLS_DIR_WINDOWS=~/.codex/skills
```

## 一次性准备

首次启动时，脚本会自动创建 `.env` 中 `MCP_SANDBOX_DIR_WINDOWS` 指定的目录。以后只把愿意交给 AI 的文件放这里；`MCP_SANDBOX_DIR` 只是默认工作目录，不是严格沙盒。

### 1. 保存 Token

```powershell
$TokenDir = Join-Path $env:USERPROFILE ".mcp"
New-Item -ItemType Directory -Force -Path $TokenDir | Out-Null
$Token = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$Token | ConvertTo-SecureString -AsPlainText -Force |
    ConvertFrom-SecureString | Set-Content (Join-Path $TokenDir "token.enc")
```

`token.enc` 使用 Windows DPAPI，只能由当前 Windows 用户在当前机器上读取。Token 不要写进仓库、Notion 页面或聊天记录。
每次启动时，`lib/up.mjs` 还会自动移除 `.mcp` 目录和 `token.enc` 的继承权限，只保留当前用户与 `SYSTEM`；可用下面命令检查：

```powershell
icacls.exe (Join-Path $TokenDir "token.enc")
```

日常不要用 Administrator 运行服务，并建议开启 BitLocker。DPAPI 和 ACL 保护磁盘上的文件，但不能阻止已经以当前用户身份运行的恶意程序读取启动器解出的 token。

需要填入 Notion 时可临时读取裸 token（不要把输出保存进文件）：

```powershell
$secure = Get-Content (Join-Path $env:USERPROFILE ".mcp\token.enc") | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
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

`up.ps1` 会启动 8001 的 Supergateway、8000 的 Bearer 鉴权代理，并用 Tailscale Funnel 暴露 8000。它会自动创建默认沙盒目录，检查 MCP initialize、鉴权和 Funnel 指向；端口冲突会直接失败，不会复用旧进程假装成功。首次使用 Tailscale 时，可能需要在管理后台开启 HTTPS 证书和 Funnel 权限。

看到下面的成功提示后，保持 PowerShell 窗口运行：

```text
✅ 8001 起来了
✅ 8000 起来了
✅ 鉴权生效（无 token → 401）
✅ Funnel 已指向 8000
```

按 `Ctrl + C` 停止。启动器会关闭 8000、8001 和 Funnel；8001 不得暴露到公网。

## Notion 配置

Agent → **Add connection → Custom MCP server**

| 字段 | 填什么 |
| --- | --- |
| Server URL | `https://<你的设备名>.<你的tailnet名>.ts.net/mcp` |
| 鉴权方式 | **Bearer Token**，前缀选 `Bearer` |
| Token | 上一步解出的裸 token，不要再手动加 `Bearer` |
| 权限 | 按需选择 |

## 安全边界

`run_command` 可以执行任意 PowerShell 命令。Token 泄露等价于允许公网调用这台 Windows 机器上当前用户可执行的命令；重要数据应另行备份。DPAPI 和 ACL 保护磁盘上的 token 文件，但不能阻止当前用户身份下的恶意程序读取启动器解出的 token。

## 工具差异

`run_command` 使用 Windows PowerShell；`read_image` 支持常见位图，SVG 需要 ImageMagick。
