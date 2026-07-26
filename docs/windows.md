# Windows

> Windows 现在有 `up.ps1` 入口，但它仍使用官方 Filesystem MCP；macOS 的 `up.sh` 使用自定义 `exec-server.mjs`，两者工具能力不完全一致。PowerShell 版本尚未在真实 Windows 环境完成验证。

用户配置集中在 `.env`。通常只需要修改 `MCP_SANDBOX_DIR_WINDOWS`；端口冲突时再调整两个端口。Token、DPAPI 文件位置和 Tailscale 路径由程序使用内置默认值处理。

## 日常使用

脚本安装到用户目录后运行：

```powershell
& "$env:USERPROFILE\.mcp\up.ps1"
```

它会启动 8001、8000，并把 Tailscale Funnel 指向 8000。看到 `✅ 鉴权生效（无 token → 401）` 后保持窗口打开；按 `Ctrl + C` 停止。

## 一次性准备

### 1. 建沙盒目录

```powershell
$ShareDir = "$env:USERPROFILE\AI-Share"
New-Item -ItemType Directory -Force -Path $ShareDir | Out-Null
"MCP connection test" | Out-File -Encoding utf8 "$ShareDir\connection-test.txt"
```

`up.ps1` 使用这个目录作为 Filesystem MCP 的允许目录。

### 2. 把 Token 存成 DPAPI 文件

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.mcp" | Out-Null
$Token = -join ((48..57)+(97..102) | Get-Random -Count 64 | ForEach-Object {[char]$_})
$Token | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Out-File "$env:USERPROFILE\.mcp\token.enc"
```

验证读取：

```powershell
$secure = Get-Content "$env:USERPROFILE\.mcp\token.enc" | ConvertTo-SecureString
[System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
```

DPAPI 文件只绑定当前 Windows 用户和机器。Token 不要写进仓库、Notion 页面或聊天记录。

### 3. 安装脚本和鉴权代理

在仓库根目录执行：

```powershell
Copy-Item .\up.ps1, .\auth-proxy.mjs, .\.env "$env:USERPROFILE\.mcp\"
Copy-Item .\lib "$env:USERPROFILE\.mcp\" -Recurse -Force
```

`up.ps1` 会从自身目录启动代理，并读取同目录的 `.env` 和 `lib/config.mjs`；Windows 版本当前不需要复制 macOS 的 `exec-server.mjs` 或 `tools`。

### 4. 首次开通 Tailscale Funnel

```powershell
tailscale funnel 8000
```

如果 `tailscale.exe` 不在 `PATH`，先把 Tailscale 加入 PATH。首次运行需要在管理后台开启 HTTPS 证书和 Funnel 权限。只能指向代理端口，不能暴露后端端口。

### 5. 启动

如果 PowerShell 禁止执行脚本：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

然后运行：

```powershell
& "$env:USERPROFILE\.mcp\up.ps1"
```

脚本使用 `curl.exe` 做 401 检查；不要把它替换成 PowerShell 的 `curl` 别名。

## Notion 配置

| 字段 | 填什么 |
| --- | --- |
| Server URL | `https://<你的设备名>.<你的tailnet名>.ts.net/mcp` |
| 鉴权方式 | **Bearer Token**，前缀选 `Bearer` |
| Token | DPAPI 文件解出的裸 token |
| 权限 | 按需选择 |

## 已知限制

- 该脚本尚未在真实 Windows 环境验证；端口检查依赖 `Test-NetConnection`。
- Windows 入口使用官方 Filesystem MCP，不包含 macOS 入口的 `run_command` 和 `read_image`。
- 如果 `Ctrl + C` 后 Funnel 没有关闭，执行 `tailscale funnel 8000 off`。
- 无论平台，Token 泄露都可能让公网调用本机服务；8001 不得暴露。
