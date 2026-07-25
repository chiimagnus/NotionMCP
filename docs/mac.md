# macOS

## 日常使用

开：

```bash
~/.mcp/up.sh
```

看到这几行就绪了：

```text
✅ 8001 起来了
✅ 8000 起来了
✅ 鉴权生效（无 token → 401）

Available on the internet:
https://macbook-pro.tailf4f6f6.ts.net/
|-- proxy http://127.0.0.1:8000
```

**这个终端全程别关。** 关：同一个终端按 `Control + C`，三个进程加 Funnel 一起停。

---

## 一次性前置

下面六件事做完就不用再碰了。换机器、重装系统才需要重来。

### 1. 建沙盒目录

```bash
SHARE_DIR="/Users/chii_magnus/Github_OpenSource/AI-Share"
mkdir -p "$SHARE_DIR"
printf 'MCP connection test\n' > "$SHARE_DIR/connection-test.txt"
```

以后只把愿意交给 AI 的文件放这里。

> 📁 沙盒坐在 `Github_OpenSource` 里没问题——Filesystem MCP 只认被授权的那一个目录，兄弟仓库碰不到。**但绝不要图省事把允许目录上提成 `Github_OpenSource` 本身**——那等于把所有仓库连同里面每一个 `.env` 一起交出去。

### 2. Token 存进钥匙串

```bash
openssl rand -hex 32                                        # 生成
security add-generic-password -a "$USER" -s mcp-token -w    # 存（输两遍，不回显、不进历史）
security find-generic-password -a "$USER" -s mcp-token -w   # 读，验证存进去了
```

第一次读会弹窗，点**「始终允许」**，否则每次启动都弹。

**这串 token 不要写进任何 Notion 页面、仓库或聊天记录。**

### 3. 鉴权反向代理

保存为 `~/.mcp/auth-proxy.mjs`（零依赖，Node 内置模块）。完整脚本见本仓库 [`auth-proxy.mjs`](./auth-proxy.mjs)。

### 5. Tailscale Funnel 首次开通

```bash
echo 'alias tailscale="/Applications/Tailscale.app/Contents/MacOS/Tailscale"' >> ~/.zshrc
source ~/.zshrc
tailscale funnel 8000
```

CLI 藏在 app 包里，默认不在 PATH。首次跑会让你去管理后台开 HTTPS 证书和 Funnel 节点权限，终端直接给链接。**必须手动跑这一次**——这个交互步骤在后台进程里会被淹掉。

开通后得到固定域名 `https://macbook-pro.tailf4f6f6.ts.net`，不用买域名、重启也不变。

> ⚠️ **只能指 8000（鉴权代理），绝不能指 8001**——指 8001 就是绕过鉴权把文件系统直接扔到公网上。输出里 `|-- proxy` 后面写着 8001 就立刻 `Control + C`。
>
> 另外：`tailscale serve` 只在自己 tailnet 内可达，Notion 在云端、永远连不上。**只有 `funnel` 是公网入口。**

### 6. 落盘一键启动脚本

保存为 `~/.mcp/up.sh` 并 `chmod +x`。2026.7.26 更新：现在起的是 `exec-server.mjs`（而不是官方 Filesystem MCP）。完整脚本见本仓库 [`up.sh`](./up.sh)。

## Notion 侧配置

Agent → **Add connection → Custom MCP server**

| 字段 | 填什么 |
| --- | --- |
| Server URL | `https://macbook-pro.tailf4f6f6.ts.net/mcp` |
| 鉴权方式 | **Bearer Token**（前缀选 `Bearer`，不是 `Token`） |
| Token | 钥匙串里那串裸的十六进制 |
| 权限 | 改动前询问 or 从不询问 |
