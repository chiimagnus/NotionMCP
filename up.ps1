$ErrorActionPreference = "Stop"

$currentPowerShell = "$($PSVersionTable.PSEdition) $($PSVersionTable.PSVersion)"
if ($PSVersionTable.PSEdition -ne "Core" -or $PSVersionTable.PSVersion.Major -lt 7) {
	throw "需要 PowerShell 7 或更高版本（pwsh），当前是 $currentPowerShell"
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node not found; install Node.js and make sure node is on PATH" }

& $node.Source (Join-Path $PSScriptRoot "lib\up.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
