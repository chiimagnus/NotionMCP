$ErrorActionPreference = "Stop"
$configFile = if ($env:MCP_CONFIG_FILE) { $env:MCP_CONFIG_FILE } else { Join-Path $PSScriptRoot ".env" }
if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { throw "找不到配置文件：$configFile" }
$env:MCP_CONFIG_FILE = $configFile
$configJson = (& node "$PSScriptRoot\lib\config.mjs" --json windows | Out-String)
if ($LASTEXITCODE -ne 0) { throw "配置读取失败：$configFile" }
$config = $configJson | ConvertFrom-Json

$ShareDir = [string]$config.sandboxDir
$ProxyPort = [int]$config.proxyPort
$UpstreamPort = [int]$config.upstreamPort
$SessionTimeoutMs = [int]$config.sessionTimeoutMs
$Tailscale = [string]$config.tailscalePath
$TokenFile = [string]$config.tokenFile
$env:MCP_SANDBOX_DIR = $ShareDir

$secure = Get-Content -LiteralPath $TokenFile | ConvertTo-SecureString
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
	if ($funnelStarted) { & $Tailscale funnel $ProxyPort off 2>$null }
}

try {
	Write-Host "→ supergateway ($UpstreamPort)"
	$gw = Start-Process -FilePath "npx.cmd" -ArgumentList @(
		"-y", "supergateway",
		"--stdio", "npx -y @modelcontextprotocol/server-filesystem `"$ShareDir`"",
		"--outputTransport", "streamableHttp",
		"--stateful",
		"--sessionTimeout", "$SessionTimeoutMs",
		"--streamableHttpPath", "/mcp",
		"--port", "$UpstreamPort"
	) -PassThru -WindowStyle Hidden
	$procs += $gw

	1..30 | ForEach-Object {
		if ((Test-NetConnection 127.0.0.1 -Port $UpstreamPort -WarningAction SilentlyContinue).TcpTestSucceeded) { return }
		Start-Sleep -Seconds 1
	}
	Write-Host "  ✅ $UpstreamPort 起来了"

	Write-Host "→ auth proxy ($ProxyPort)"
	$proxy = Start-Process -FilePath "node" -ArgumentList "`"$PSScriptRoot\auth-proxy.mjs`"" -PassThru -WindowStyle Hidden
	$procs += $proxy

	1..15 | ForEach-Object {
		if ((Test-NetConnection 127.0.0.1 -Port $ProxyPort -WarningAction SilentlyContinue).TcpTestSucceeded) { return }
		Start-Sleep -Seconds 1
	}
	Write-Host "  ✅ $ProxyPort 起来了"

	$code = (curl.exe -s -o NUL -w "%{http_code}" "http://127.0.0.1:$ProxyPort/mcp" --max-time 2)
	if ($code -ne "401") { Write-Error "  ❌ 无 token 竟然不是 401（是 $code），鉴权没生效，中止"; exit 1 }
	Write-Host "  ✅ 鉴权生效（无 token → 401）"

	Write-Host "→ tailscale funnel（下面会打印 .ts.net 公网地址）"
	& $Tailscale funnel $ProxyPort
	$funnelStarted = $true

	Write-Host "`n全部起来了。Ctrl + C 停掉（含关闭 Funnel）。"
	while ($true) { Start-Sleep -Seconds 3600 }
}
finally {
	Cleanup
}
