#!/bin/bash
# up.sh — 一键启动：exec-server（后端）+ supergateway（streamableHttp 多会话）
#         + auth-proxy（鉴权）+ Tailscale Funnel（公网入口）
#
# 2026.7.26 升级：后端从官方 Filesystem MCP（只读写）换成自定义 exec-server.mjs
# （run_command，能跑任意命令）。auth-proxy.mjs 不用改，鉴权层和协议层没变。
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SHARE_DIR="${MCP_SANDBOX_DIR:-$HOME/Github_OpenSource/AI-Share}"
MCP_DIR="$SCRIPT_DIR"

for required_file in \
	"$MCP_DIR/exec-server.mjs" \
	"$MCP_DIR/auth-proxy.mjs" \
	"$MCP_DIR/lib/rpc.mjs" \
	"$MCP_DIR/tools/index.mjs"; do
	if [ ! -f "$required_file" ]; then
		echo "❌ 缺少运行文件：$required_file"
		exit 1
	fi
done

# tailscale 藏在 app 包里，默认不在 PATH。非交互式脚本不会继承你 ~/.zshrc 里的 alias，
# 所以这里自己解析一次真实路径，不依赖 alias。
if command -v tailscale >/dev/null 2>&1; then
	TAILSCALE="tailscale"
else
	TAILSCALE="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
fi
if [ ! -x "$TAILSCALE" ] && ! command -v "$TAILSCALE" >/dev/null 2>&1; then
	echo "❌ 找不到 tailscale 可执行文件（试过 PATH 和 $TAILSCALE），确认 Tailscale.app 装在 /Applications 里"
	exit 1
fi

TOKEN=$(security find-generic-password -a "$USER" -s mcp-token -w 2>/dev/null)
if [ -z "$TOKEN" ]; then
	echo "❌ 读不到 token，先看一次性前置第 2 步"
	exit 1
fi
export MCP_TOKEN="$TOKEN"
export MCP_SANDBOX_DIR="$SHARE_DIR"

SUPERGATEWAY_PID=""
PROXY_PID=""

cleanup() {
	echo ""
	echo "关闭中…"
	[ -n "$SUPERGATEWAY_PID" ] && kill "$SUPERGATEWAY_PID" 2>/dev/null
	[ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
	"$TAILSCALE" funnel 8000 off >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

# 1. 起后端 exec-server，supergateway 包成 streamableHttp，多会话（每个 session 独立子进程）
npx -y supergateway \
	--stdio "node $MCP_DIR/exec-server.mjs" \
	--outputTransport streamableHttp \
	--port 8001 \
	--stateful \
	--sessionTimeout 3600000 &
SUPERGATEWAY_PID=$!

sleep 2
if lsof -i :8001 >/dev/null 2>&1; then
	echo "✅ 8001 起来了"
else
	echo "❌ 8001 没起来，看上面 supergateway 的报错"
	exit 1
fi

# 2. 起鉴权反向代理（8000 → 认证 → 转发到 8001）
node "$MCP_DIR/auth-proxy.mjs" &
PROXY_PID=$!

sleep 1
if lsof -i :8000 >/dev/null 2>&1; then
	echo "✅ 8000 起来了"
else
	echo "❌ 8000 没起来，看上面 auth-proxy 的报错"
	exit 1
fi

# 3. 验证鉴权：不带 token 应该 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8000/mcp)
if [ "$STATUS" = "401" ]; then
	echo "✅ 鉴权生效（无 token → 401）"
else
	echo "⚠️ 鉴权检查返回 $STATUS，请确认 auth-proxy 是否正常"
fi

# 4. 开 Tailscale Funnel（公网入口，只指向 8000）
echo ""
"$TAILSCALE" funnel 8000
