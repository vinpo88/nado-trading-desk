param(
    [ValidateSet('start', 'run', 'status', 'stop')]
    [string] $Action = 'status',
    [string] $Config = 'registration.group.local.json'
)

$ErrorActionPreference = 'Stop'
$registrationRepo = Split-Path -Parent $PSScriptRoot
$registrationEntry = Join-Path $registrationRepo 'scripts\registration\group.mjs'
$registrationConfig = if ([IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $registrationRepo $Config }

try {
    $registrationNode = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if (-not (Test-Path -LiteralPath $registrationConfig -PathType Leaf)) {
        Write-Host '缺少 registration.group.local.json，请按 README 的双浏览器步骤配置。'
        exit 1
    }
    Push-Location -LiteralPath $registrationRepo
    try {
        & $registrationNode.Source $registrationEntry $Action --config $registrationConfig
        $registrationExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    exit $registrationExit
} catch {
    Write-Host '并发组命令未完成，请检查 Node.js、公开配置和执行器状态。' -ForegroundColor Red
    exit 1
}
