#!/bin/bash
# up.sh — 一键启动：exec-server（后端）+ supergateway（streamableHttp 多会话）
#         + auth-proxy（鉴权）+ Tailscale Funnel（公网入口）
set -euo pipefail

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

if [ "$PROXY_PORT" = "$UPSTREAM_PORT" ]; then
	echo "❌ 8000 和 8001 不能使用同一个端口"
	exit 1
fi

port_listeners() {
	lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true
}

require_port_free() {
	local port="$1"
	local listeners
	listeners=$(port_listeners "$port")
	if [ -n "$listeners" ]; then
		echo "❌ 端口 $port 已被占用，停止启动以避免复用旧进程："
		echo "$listeners"
		echo "先关闭占用它的进程，或修改 .env 中的端口"
		return 1
	fi
}

# ponytail: 只回收本脚本持有的 PID，不按端口杀进程，避免误伤其他服务。
stop_process_tree() {
	local pid="$1"
	local child
	[ -n "$pid" ] || return 0
	for child in $(pgrep -P "$pid" 2>/dev/null || true); do
		stop_process_tree "$child"
	done
	kill "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
}

wait_for_http() {
	local pid="$1"
	local url="$2"
	local status
	local attempt=1
	while [ "$attempt" -le 30 ]; do
		if ! kill -0 "$pid" 2>/dev/null; then
			return 1
		fi
		status=$(curl -sS --connect-timeout 1 --max-time 2 -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || true)
		if [ "$status" != "000" ]; then
			return 0
		fi
		sleep 0.5
		attempt=$((attempt + 1))
	done
	return 1
}

require_port_free "$UPSTREAM_PORT"
require_port_free "$PROXY_PORT"

SUPERGATEWAY_PID=""
PROXY_PID=""
FUNNEL_STARTED=0

cleanup() {
	trap - EXIT INT TERM
	echo ""
	echo "关闭中…"
	stop_process_tree "$SUPERGATEWAY_PID"
	stop_process_tree "$PROXY_PID"
	if [ "$FUNNEL_STARTED" -eq 1 ]; then
		"$TAILSCALE" funnel reset >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"up.sh","version":"1"}}}'

# 1. 起后端 exec-server，supergateway 包成 streamableHttp，多会话（每个 session 独立子进程）
npx -y supergateway \
	--stdio "node \"$MCP_DIR/exec-server.mjs\"" \
	--outputTransport streamableHttp \
	--port "$UPSTREAM_PORT" \
	--stateful \
	--sessionTimeout "$SESSION_TIMEOUT_MS" &
SUPERGATEWAY_PID=$!

if wait_for_http "$SUPERGATEWAY_PID" "http://127.0.0.1:$UPSTREAM_PORT/mcp"; then
	STATUS=$(curl -sS --connect-timeout 2 --max-time 10 -o /dev/null -w "%{http_code}" \
		-H "Content-Type: application/json" \
		-H "Accept: application/json, text/event-stream" \
		--data "$MCP_INIT" "http://127.0.0.1:$UPSTREAM_PORT/mcp" 2>/dev/null || true)
	if [ "$STATUS" != "200" ]; then
		echo "❌ $UPSTREAM_PORT 的 MCP initialize 失败（HTTP $STATUS）"
		exit 1
	fi
	echo "✅ $UPSTREAM_PORT 起来了"
else
	echo "❌ $UPSTREAM_PORT 没起来，看上面 supergateway 的报错"
	exit 1
fi

# 2. 起鉴权反向代理（8000 → 认证 → 转发到 8001）
node "$MCP_DIR/auth-proxy.mjs" &
PROXY_PID=$!

if wait_for_http "$PROXY_PID" "http://127.0.0.1:$PROXY_PORT/mcp"; then
	echo "✅ $PROXY_PORT 起来了"
else
	echo "❌ $PROXY_PORT 没起来，看上面 auth-proxy 的报错"
	exit 1
fi

# 3. 验证鉴权：不带 token 应该 401
STATUS=$(curl -sS --connect-timeout 2 --max-time 10 -o /dev/null -w "%{http_code}" \
	"http://127.0.0.1:$PROXY_PORT/mcp" 2>/dev/null || true)
if [ "$STATUS" = "401" ]; then
	echo "✅ 鉴权生效（无 token → 401）"
else
	echo "❌ 鉴权检查失败（无 token 返回 HTTP $STATUS）"
	exit 1
fi

STATUS=$(curl -sS --connect-timeout 2 --max-time 10 -o /dev/null -w "%{http_code}" \
	-H "Authorization: Bearer $TOKEN" \
	-H "Content-Type: application/json" \
	-H "Accept: application/json, text/event-stream" \
	--data "$MCP_INIT" "http://127.0.0.1:$PROXY_PORT/mcp" 2>/dev/null || true)
if [ "$STATUS" != "200" ]; then
	echo "❌ 鉴权后的 MCP initialize 失败（HTTP $STATUS）"
	exit 1
fi

# 4. 开 Tailscale Funnel（公网入口，只指向 8000）
echo ""
if ! "$TAILSCALE" funnel reset >/dev/null 2>&1; then
	echo "❌ 无法清理现有 Tailscale Funnel 配置"
	exit 1
fi
if ! "$TAILSCALE" funnel --bg "$PROXY_PORT"; then
	echo "❌ Tailscale Funnel 启动失败；可能有旧的前台 Funnel 占用 443，请先关闭它"
	exit 1
fi
FUNNEL_STARTED=1

FUNNEL_STATUS=$("$TAILSCALE" funnel status --json 2>/dev/null || true)
if ! printf '%s\n' "$FUNNEL_STATUS" | grep -Fq "http://127.0.0.1:$PROXY_PORT"; then
	echo "❌ Funnel 启动后未指向 127.0.0.1:$PROXY_PORT"
	exit 1
fi
echo "✅ Funnel 已指向 $PROXY_PORT"

echo ""
echo "保持此终端运行，按 Ctrl+C 停止"
while kill -0 "$SUPERGATEWAY_PID" 2>/dev/null && \
	kill -0 "$PROXY_PID" 2>/dev/null && \
	[ -n "$(port_listeners "$UPSTREAM_PORT")" ] && \
	[ -n "$(port_listeners "$PROXY_PORT")" ]; do
	sleep 1
done

echo "❌ MCP 进程意外退出，服务已停止"
exit 1
