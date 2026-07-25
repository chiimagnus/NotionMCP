$ErrorActionPreference = "Stop"
$ShareDir = "$env:USERPROFILE\AI-Share"

$secure = Get-Content "$env:USERPROFILE\.mcp\token.enc" | ConvertTo-SecureString
$env:MCP_TOKEN = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
	[System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if (-not $env:MCP_TOKEN) { Write-Error "DPAPI 文件里没有 token"; exit 1 }

$procs = @()
$funnelStarted = $false

function Cleanup {
	Write-Host "`n正在停止..."
	foreach ($p in $procs) {
		if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
	}
	if ($funnelStarted) { tailscale funnel 8000 off 2>$null }
}

try {
	Write-Host "→ supergateway (8001)"
	$gw = Start-Process -FilePath "npx.cmd" -ArgumentList @(
		"-y", "supergateway",
		"--stdio", "npx -y @modelcontextprotocol/server-filesystem $ShareDir",
		"--outputTransport", "streamableHttp",
		"--stateful",
		"--sessionTimeout", "3600000",
		"--streamableHttpPath", "/mcp",
		"--port", "8001"
	) -PassThru -WindowStyle Hidden
	$procs += $gw

	1..30 | ForEach-Object {
		if ((Test-NetConnection 127.0.0.1 -Port 8001 -WarningAction SilentlyContinue).TcpTestSucceeded) { return }
		Start-Sleep -Seconds 1
	}
	Write-Host "  ✅ 8001 起来了"

	Write-Host "→ auth proxy (8000)"
	$proxy = Start-Process -FilePath "node" -ArgumentList "$env:USERPROFILE\.mcp\auth-proxy.mjs" -PassThru -WindowStyle Hidden
	$procs += $proxy

	1..15 | ForEach-Object {
		if ((Test-NetConnection 127.0.0.1 -Port 8000 -WarningAction SilentlyContinue).TcpTestSucceeded) { return }
		Start-Sleep -Seconds 1
	}
	Write-Host "  ✅ 8000 起来了"

	$code = (curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:8000/mcp --max-time 2)
	if ($code -ne "401") { Write-Error "  ❌ 无 token 竟然不是 401（是 $code），鉴权没生效，中止"; exit 1 }
	Write-Host "  ✅ 鉴权生效（无 token → 401）"

	Write-Host "→ tailscale funnel（下面会打印 .ts.net 公网地址）"
	tailscale funnel 8000
	$funnelStarted = $true

	Write-Host "`n全部起来了。Ctrl + C 停掉（含关闭 Funnel）。"
	while ($true) { Start-Sleep -Seconds 3600 }
}
finally {
	Cleanup
}
