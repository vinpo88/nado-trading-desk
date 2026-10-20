param(
    [ValidateSet('start', 'run', 'status', 'stop', 'setup')]
    [string] $Action = 'status',
    [string] $Config
)

$ErrorActionPreference = 'Stop'
$registrationRepo = Split-Path -Parent $PSScriptRoot
$registrationEntry = Join-Path $registrationRepo 'scripts\registration\worker.mjs'
$registrationConfig = if ($Config) {
    if ([IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $registrationRepo $Config }
} else {
    Join-Path $registrationRepo 'registration.worker.local.json'
}

try {
    $registrationNode = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if (-not (Test-Path -LiteralPath $registrationConfig -PathType Leaf)) {
        if ($Action -notin @('start', 'run', 'setup')) {
            throw '尚无本地执行器配置，请先运行 Open-Registration.cmd。'
        }
        if ($Config) { throw '指定的配置文件不存在。' }
        Copy-Item -LiteralPath (Join-Path $registrationRepo 'registration.worker.example.json') -Destination $registrationConfig -ErrorAction Stop
        Write-Host '已创建 registration.worker.local.json；默认从 10000 倒序。'
    }
    Push-Location -LiteralPath $registrationRepo
    try {
        $registrationCommand = if ($Action -eq 'setup') { 'open' } else { $Action }
        & $registrationNode.Source $registrationEntry $registrationCommand --config $registrationConfig
        $registrationExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    exit $registrationExit
} catch {
    # Never include browser errors, request payloads, or credentials here.
    Write-Host '执行器入口未完成，请检查 Node.js 安装、本地配置和上方提示。' -ForegroundColor Red
    exit 1
}
