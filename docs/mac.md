# macOS

## 一次性准备

### 1. 建沙盒目录

默认目录是 `~/Github_OpenSource/AI-Share`，也可以通过 `MCP_SANDBOX_DIR` 覆盖：

```bash
SHARE_DIR="${MCP_SANDBOX_DIR:-$HOME/Github_OpenSource/AI-Share}"
mkdir -p "$SHARE_DIR"
printf 'MCP connection test\n' > "$SHARE_DIR/connection-test.txt"
```

以后只把愿意交给 AI 的文件放这里。这个目录只是命令的默认工作目录，不是严格沙盒；`run_command` 仍可访问绝对路径或通过 `cd` 离开它。

### 2. 把 Token 存进钥匙串

```bash
openssl rand -hex 32
security add-generic-password -a "$USER" -s mcp-token -w
security find-generic-password -a "$USER" -s mcp-token -w
```

第一次读取时点钥匙串弹窗里的「始终允许」。Token 不要写进仓库、Notion 页面或聊天记录。

### 3. 首次开通 Tailscale Funnel

```bash
tailscale funnel 8000
```

如果 CLI 不在 `PATH`：

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel 8000
```

首次运行会要求在管理后台开启 HTTPS 证书和 Funnel 权限。只允许 Funnel 指向 8000；8001 是后端端口，不能暴露到公网。`up.sh` 会自动寻找 `PATH` 或上述 App 内的 CLI，不依赖 shell alias。

## 启动

仓库根目录执行：

```bash
chmod +x ./up.sh
./up.sh
```

`up.sh` 会启动：

- 8001：`exec-server.mjs` 经 Supergateway 包装后的 Streamable HTTP；
- 8000：只监听 `127.0.0.1` 的 Bearer Token 鉴权代理；
- Tailscale Funnel：只指向 8000。

看到下面几行后，保持终端运行：

```text
✅ 8001 起来了
✅ 8000 起来了
✅ 鉴权生效（无 token → 401）

Available on the internet:
https://<你的设备名>.<你的tailnet名>.ts.net/
|-- proxy http://127.0.0.1:8000
```

按 `Control + C` 停止；脚本会尝试关闭 8000、8001 和 Funnel。若 Funnel 仍在运行，手动执行：

```bash
tailscale funnel 8000 off
```

## Notion 配置

Agent → **Add connection → Custom MCP server**

| 字段 | 填什么 |
| --- | --- |
| Server URL | `https://<你的设备名>.<你的tailnet名>.ts.net/mcp` |
| 鉴权方式 | **Bearer Token**，前缀选 `Bearer` |
| Token | 钥匙串里的裸 token，不要再手动加 `Bearer` |
| 权限 | 按需选择 |

## 安全边界

`run_command` 可以执行任意 shell 命令。Token 泄露等价于允许公网调用这台 Mac 上的任意命令；重要数据应另行备份。不要把 Funnel 指向 8001，也不要把 `MCP_SANDBOX_DIR` 误认为强制隔离。
