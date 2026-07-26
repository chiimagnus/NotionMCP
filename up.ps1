$ErrorActionPreference = "Stop"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "node not found; install Node.js and make sure node is on PATH" }

& $node.Source (Join-Path $PSScriptRoot "lib\up.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
