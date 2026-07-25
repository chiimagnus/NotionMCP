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

进程挂了 Notion 就调不动工具——**这是安全的失败方式，不是 bug**。不用就关掉，比任何防护都有效。

> 🚪 跑着的时候去查 `tailscale funnel status` 会显示 `No serve config`——**正常**。前台模式不写持久配置，以 `Available on the internet` 那段为准。好处是进程一死公网入口就没了，不会遗留。

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

### 4. 执行后端（run_command + read_image）

保存为 `~/.mcp/exec-server.mjs`（连同同目录下的 `lib/`、`tools/` 两个子目录）。这是自定义的 MCP 后端，暴露两个工具：`run_command`（跑任意 shell 命令，python、pip、ffmpeg、改 CSV、生成 SVG 都靠它）和 `read_image`（把图片文件读回来编码成图片内容返回，SVG 会先用 macOS 自带 QuickLook 转成 PNG——因为 AI 只能"看"位图，看不了矢量源码）。替代官方 Filesystem MCP。完整代码见本仓库 [`exec-server.mjs`](./exec-server.mjs)、[`lib/`](./lib)、[`tools/`](./tools) 目录。

2026.7.26 晚些时候起，`exec-server.mjs` 从单文件拆成了入口 + `lib/`（共享辅助函数）+ `tools/`（一个工具一个文件：`run_command.mjs`、`read_image.mjs`），单文件不再有 270 行，改起来更容易定位对应工具。行为和之前的单文件版本完全一致，只是文件组织变了（版本号同步升到 1.2.0）。

> 🔄 **已有旧版时如何升级：** 1）从本仓库拉取/覆盖最新的 `exec-server.mjs` 及 `lib/`、`tools/` 目录到 `~/.mcp/` 下；2）回到跑着 `up.sh` 的终端按 `Control + C` 停掉；3）重新执行 `~/.mcp/up.sh`。Node 不会热更新代码，不重启新工具不会生效；Notion 侧也要在 Custom MCP server 设置里重新扫一次工具列表才会看到新工具。

> ⚠️ **这不是沙箱。** `cwd` 只是默认工作目录，不是强制边界——`cd / && rm -rf xxx` 或任何绝对路径依然能跑到沙盒外面。真正挡住"任何人从公网执行任意命令"的，只有 auth-proxy 校验的那串 Bearer Token。2026.7.26 起这是有意识的取舍：不做 `sandbox-exec` / Docker 之类的强隔离，换取更大的能力（能跑绝大部分脚本任务），代价是 token 一旦泄露 = 这台 Mac 被远程任意执行代码。**保管 token 的注意事项（钥匙串、不进仓库/聊天记录）比以前更重要。**

每次调用会追加一行日志到 `~/.mcp/exec.log`（时间戳 + 命令 + 退出码），纯粹方便事后回溯，不是安全闸门、不会拦截任何命令。

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

> 🎯 **为什么是 Bearer Token。** 代理校验的是 `Authorization: Bearer <token>`，这个选项正好自动拼出这个头——所以只填裸 token，**自己再加一遍会变成 `Bearer Bearer xxx` 直接 401**。前缀选 `Token` 会发出 `Authorization: Token xxx`（GitHub 老式写法），也对不上。
>
> 另外两个：`OAuth` 要求服务器实现授权流，我们那几十行没有；`Basic` 发 `Authorization: Basic base64(用户名:密码)`，格式不对。

保存后会自动扫工具。**扫描本身会建 SSE 会话，确保这时候没有别的客户端连着（curl 已断、Inspector 已关）。**

✅ 工具列表里应该有两个工具：`run_command` 和 `read_image`（后端换成自定义 exec-server.mjs，不再是官方 Filesystem MCP 的 14 个读写工具）。内部虽然拆成了 `lib/` + `tools/` 多个文件，但 Notion 侧看到的接口不变，还是这两个工具。

## 已知限制与待验证

**已实测确认的限制**

- **空闲连接约 50 秒被断。** 尚未定位是本地 HTTP 代理、Tailscale 中继还是 supergateway 无心跳。

**已解决**

- **多会话支持（2026.7.26）。** `up.sh` 改用 `--outputTransport streamableHttp --stateful`，endpoint 换成 `/mcp`，每个 session 独立启动一个后端子进程，并加了 1 小时 session 超时（`--sessionTimeout 3600000`）。用两个并发 `initialize` 请求验证：均返回 200，且拿到不同的 `mcp-session-id`。`auth-proxy.mjs` 不用改。原来「supergateway 只撑得住一个 SSE 会话，第二个连接进来立刻崩」的限制已解除。官方模式参考 [Supergateway](https://github.com/supercorp-ai/supergateway)。
- **执行能力（2026.7.26）。** 后端从官方 Filesystem MCP（14 个读写工具）换成自定义 `exec-server.mjs`（`run_command` 工具，能跑任意 shell 命令）。这是主动选择放弃"参数受限的窄工具"路线，换取跑 python/训练脚本/生成图片等真实任务的能力；代价和边界见步骤 4 的红色提示。
- **看图能力（2026.7.26）。** 新增 `read_image` 工具：把图片文件（SVG 会先用 macOS 自带 QuickLook 转成 PNG）读回来编码成图片内容返回。之前 `run_command` 只能吐文本——AI 能读到 SVG 源码，但看不到渲染效果；现在能真正"看到"本地生成的图。
- **代码可维护性重构（2026.7.26 晚）。** `exec-server.mjs` 从 270 行单文件拆成入口 + `lib/`（共享辅助函数）+ `tools/`（一个工具一个文件），行为完全不变，纯粹是为了后续加工具/改工具时更容易定位。`~/.mcp` 文件夹本身建了本地 git 仓库（未配置远程，不会自动 push），后续改动可以直接在这里 `git commit` 留版本记录。

**待验证**

- [ ] 那 50 秒空闲断连会不会影响 Notion？看它会不会自动重连。若反复掉线，得加心跳或抬中间层超时
- [ ] Notion 对 SSE vs Streamable HTTP 哪种更稳
- [ ] `run_command` 跑长任务（比如 PINN 训练）时，`timeoutMs` 拉到上限（1 小时）够不够；不够的话要考虑后台跑 + 轮询日志的模式
- [ ] 开机自启（LaunchAgent 调 `~/.mcp/up.sh`，**token 依然从钥匙串取，绝不写进 plist**）——稳定跑几天再说
- [ ] `read_image` 依赖 macOS 自带 `qlmanage` 转 SVG，复杂/超大 SVG 的转换稳定性和耗时还没跑过真实用例

**风险取舍（2026.7.26 起生效）**

不再遵循"永远不加任意 Shell"——现在 `run_command` 就是任意 Shell。做这个决定前想清楚两件事，跟"AI 聪不聪明"无关：

- **不可逆操作**：这是真实的、唯一的 Mac 文件系统，没有回收站。任何一次命令写错（路径算错、通配符扫太广）都可能是不可逆的。真正的兜底应该是"重要数据在别处有备份"，而不是"模型不会犯错"。
- **提示词注入**：能不能得手取决于工具能做什么，不取决于模型判断力强不强——只要同一个会话里既读了不可信内容（网页/邮件/他人分享的文档），又拿着一个能跑任意命令的工具，就存在被诱导误用的结构性风险。安全护栏只是降低概率，不是消除。

接受这两条前提下，`exec-server.mjs` 的唯一防线就是 auth-proxy 的 Bearer Token——**token 不泄露，风险敞口就只在"自己/AI 操作失误"这一层；token 一旦泄露，敞口就是"任何人远程任意执行代码"。**
