$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "找不到 node，请先安装 Node.js 并确认 node 在 PATH 中" }

& $node.Source (Join-Path $PSScriptRoot "lib\up.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
