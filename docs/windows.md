# Windows

> ⚠️ 思路和 macOS 版完全一致（沙盒目录 + 鉴权反向代理 + Tailscale Funnel），但命令行工具链不同：PowerShell 代替 bash、Windows DPAPI 加密代替钥匙串。**这一节是按 macOS 版逐步翻译推导出来的，尚未在真实 Windows 机器上跑通验证**。按此操作时请对照实际报错调整，跑通后请回来把结论从「待验证」移到「已验证」。

## 日常使用

开（PowerShell）：

```powershell
& "$env:USERPROFILE\.mcp\up.ps1"
```

看到这几行就绪了：

```text
✅ 8001 起来了
✅ 8000 起来了
✅ 鉴权生效（无 token → 401）

Available on the internet:
https://<你的设备名>.<你的tailnet>.ts.net/
```

**这个终端窗口全程别关。** 关：同一个窗口按 `Ctrl + C`，脚本的 `finally` 块会尝试停掉三个进程和 Funnel；如果退出不干净，用下面「已知限制」里的清理命令兜底。

## 一次性前置（Windows）

下面五件事做完就不用再碰了。换机器、重装系统才需要重来。

### 1. 建沙盒目录

```powershell
$ShareDir = "$env:USERPROFILE\AI-Share"
New-Item -ItemType Directory -Force -Path $ShareDir | Out-Null
"MCP connection test" | Out-File -Encoding utf8 "$ShareDir\connection-test.txt"
```

以后只把愿意交给 AI 的文件放这里。同 macOS 一样：**不要把允许目录上提到整个用户目录或某个大仓库根目录**，那等于把目录下所有内容一起交出去。

### 2. Token 存进 Windows DPAPI 加密文件

Windows 没有和 macOS 钥匙串完全对等、方便脚本读回的工具（`cmdkey` 存的密码脚本读不回来）。这里用 **DPAPI**（Windows 数据保护 API）代替：加密后的文件只有同一台机器、同一个 Windows 账号能解开，安全模型和钥匙串等价。

```powershell
# 生成 token 并加密存盘（只需一次）
$Token = -join ((48..57)+(97..102) | Get-Random -Count 64 | ForEach-Object {[char]$_})
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.mcp" | Out-Null
$Token | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Out-File "$env:USERPROFILE\.mcp\token.enc"

# 验证能读回来
$secure = Get-Content "$env:USERPROFILE\.mcp\token.enc" | ConvertTo-SecureString
[System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
	[System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
```

**这串 token 不要写进任何 Notion 页面、仓库或聊天记录。**`token.enc` 换用户、换机器都无法解密，重装系统需要重新生成并在 Notion 侧重新填写。

### 3. 鉴权反向代理

和 macOS 完全一样的 Node.js 脚本可以直接跨平台复用（只用了 `node:http` 内置模块）。完整脚本见本仓库 [`auth-proxy.mjs`](./auth-proxy.mjs)（与 macOS 版共用同一份文件），保存到 `$env:USERPROFILE\.mcp\auth-proxy.mjs`。

同样的两处红线：`"127.0.0.1"` 不能删（否则局域网任何设备可直连绕过隧道）；粘贴时确认反引号内的 `${TOKEN}` 没被破坏。

### 4. Tailscale Funnel 首次开通

Windows 版 Tailscale 装好后 CLI 就是 `tailscale`（安装器通常会自动加入 PATH；若提示找不到命令，用完整路径 `& "C:\Program Files\Tailscale\tailscale.exe" funnel 8000`）。

```powershell
tailscale funnel 8000
```

首次会跳出管理后台链接，需要手动去开 HTTPS 证书和 Funnel 权限（和 macOS 一样，这一步不能放进后台脚本，必须手动跑一次）。开通后会拿到固定域名 `https://<设备名>.<tailnet名>.ts.net`。

> ⚠️ 同 macOS：**只能指向 8000（鉴权代理），绝不能指向 8001**。`tailscale serve` 只在 tailnet 内可达，Notion 云端连不上，只有 `funnel` 是公网入口。

### 5. 落盘一键启动脚本

保存为 `$env:USERPROFILE\.mcp\up.ps1`。完整脚本见本仓库 [`up.ps1`](./up.ps1)。

> 🔒 **两处 Windows 特有的坑：**
> ① 若报错「无法加载文件 …… 因为在此系统上禁止运行脚本」，先执行 `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`（只放行当前用户，不动系统策略）。
> ② PowerShell 里 `curl` 默认是 `Invoke-WebRequest` 的别名，脚本里必须写**`curl.exe`**（带扩展名）才是真正的 curl，否则 401 检测那一步会出错。

## Notion 侧配置（Windows，与 macOS 一致）

和 macOS 完全一样的填法，只是 Server URL 换成 Windows 机器自己的 Funnel 域名：

| 字段 | 填什么 |
| --- | --- |
| Server URL | `https://<你的设备名>.<tailnet名>.ts.net/mcp` |
| 鉴权方式 | **Bearer Token**（前缀选 `Bearer`，不是 `Token`） |
| Token | `token.enc` 解密出来的裸十六进制串 |
| 权限 | 改动前询问 or 从不询问 |
