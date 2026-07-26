#!/bin/bash
# up.sh — 一键启动：exec-server（后端）+ supergateway（streamableHttp 多会话）
#         + auth-proxy（鉴权）+ Tailscale Funnel（公网入口）
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$SCRIPT_DIR"
CONFIG_FILE="${MCP_CONFIG_FILE:-$MCP_DIR/.env}"

if [ ! -f "$CONFIG_FILE" ]; then
	echo "❌ 找不到配置文件：$CONFIG_FILE"
	exit 1
fi
export MCP_CONFIG_FILE="$CONFIG_FILE"

CONFIG_OUTPUT=$(node "$MCP_DIR/lib/config.mjs" --lines macos) || {
	echo "❌ 配置读取失败"
	exit 1
}
CONFIG_VALUES=()
while IFS= read -r line; do
	CONFIG_VALUES[${#CONFIG_VALUES[@]}]="$line"
done <<< "$CONFIG_OUTPUT"
if [ "${#CONFIG_VALUES[@]}" -ne 6 ]; then
	echo "❌ 配置读取结果不完整"
	exit 1
fi
SHARE_DIR="${CONFIG_VALUES[0]}"
PROXY_PORT="${CONFIG_VALUES[1]}"
UPSTREAM_PORT="${CONFIG_VALUES[2]}"
SESSION_TIMEOUT_MS="${CONFIG_VALUES[3]}"
TOKEN_SERVICE="${CONFIG_VALUES[4]}"
TAILSCALE_CONFIGURED="${CONFIG_VALUES[5]}"

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
	TAILSCALE="$TAILSCALE_CONFIGURED"
fi
if [ ! -x "$TAILSCALE" ] && ! command -v "$TAILSCALE" >/dev/null 2>&1; then
	echo "❌ 找不到 tailscale 可执行文件（试过 PATH 和 $TAILSCALE），确认 Tailscale.app 装在 /Applications 里"
	exit 1
fi

TOKEN=$(security find-generic-password -a "$USER" -s "$TOKEN_SERVICE" -w 2>/dev/null)
if [ -z "$TOKEN" ]; then
	echo "❌ 读不到 token，先看一次性前置第 2 步"
	exit 1
fi
export MCP_TOKEN="$TOKEN"
export MCP_SANDBOX_DIR="$SHARE_DIR"

SUPERGATEWAY_PID=""
PROXY_PID=""
FUNNEL_STARTED=0

# 每次启动都从干净的 Funnel 配置开始，避免旧的前台 listener 占用 443。
if ! "$TAILSCALE" funnel reset >/dev/null 2>&1; then
	echo "❌ 无法清理现有 Tailscale Funnel 配置"
	exit 1
fi
FUNNEL_STARTED=1

cleanup() {
	echo ""
	echo "关闭中…"
	[ -n "$SUPERGATEWAY_PID" ] && kill "$SUPERGATEWAY_PID" 2>/dev/null
	[ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null
	[ "$FUNNEL_STARTED" -eq 1 ] && "$TAILSCALE" funnel reset >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

# 1. 起后端 exec-server，supergateway 包成 streamableHttp，多会话（每个 session 独立子进程）
npx -y supergateway \
	--stdio "node \"$MCP_DIR/exec-server.mjs\"" \
	--outputTransport streamableHttp \
	--port "$UPSTREAM_PORT" \
	--stateful \
	--sessionTimeout "$SESSION_TIMEOUT_MS" &
SUPERGATEWAY_PID=$!

sleep 2
if lsof -i ":$UPSTREAM_PORT" >/dev/null 2>&1; then
	echo "✅ $UPSTREAM_PORT 起来了"
else
	echo "❌ $UPSTREAM_PORT 没起来，看上面 supergateway 的报错"
	exit 1
fi

# 2. 起鉴权反向代理（8000 → 认证 → 转发到 8001）
node "$MCP_DIR/auth-proxy.mjs" &
PROXY_PID=$!

sleep 1
if lsof -i ":$PROXY_PORT" >/dev/null 2>&1; then
	echo "✅ $PROXY_PORT 起来了"
else
	echo "❌ $PROXY_PORT 没起来，看上面 auth-proxy 的报错"
	exit 1
fi

# 3. 验证鉴权：不带 token 应该 401
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PROXY_PORT/mcp")
if [ "$STATUS" = "401" ]; then
	echo "✅ 鉴权生效（无 token → 401）"
else
	echo "⚠️ 鉴权检查返回 $STATUS，请确认 auth-proxy 是否正常"
fi

# 4. 开 Tailscale Funnel（公网入口，只指向 8000）
echo ""
"$TAILSCALE" funnel "$PROXY_PORT"
