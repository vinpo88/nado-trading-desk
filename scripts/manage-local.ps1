param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('start', 'stop')]
    [string] $Action,
    [ValidateSet('offline', 'online')]
    [string] $Mode = 'offline',
    [switch] $NoBrowser
)

$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoDir 'apps\console'
$entryPath = Join-Path $appDir 'scripts\run-next.mjs'
$stateDir = Join-Path $repoDir '.local'
$statePath = Join-Path $stateDir 'server.json'

function Get-OwnedServer($saved) {
    if ($null -eq $saved -or $saved.entry -ne $entryPath) { return $null }
    $server = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$saved.pid)"
    if ($null -eq $server -or $server.Name -ne 'node.exe') { return $null }
    if (-not $server.CommandLine -or $server.CommandLine.IndexOf($entryPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
    $started = (Get-Process -Id $saved.pid -ErrorAction SilentlyContinue).StartTime
    if ($null -eq $started -or $started.ToUniversalTime().Ticks -ne ([datetime]$saved.startedUtc).ToUniversalTime().Ticks) { return $null }
    return $server
}

function Stop-OwnedServer($saved) {
    if ($null -eq (Get-OwnedServer $saved)) {
        throw '记录中的进程已不是此 Nado 服务，未停止任何进程。'
    }
    # The PID, creation time and absolute entry path were checked above. /T stops
    # the Next.js child with its wrapper; unrelated processes are not targeted.
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID ([int]$saved.pid) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Windows 无法停止 Nado 服务及其子进程。' }
    Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
}

try {
    $saved = if (Test-Path -LiteralPath $statePath) {
        Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    } else { $null }

    if ($Action -eq 'stop') {
        if ($null -eq $saved) { Write-Host '没有找到由此启动器启动的 Nado 服务。'; exit 0 }
        Stop-OwnedServer $saved
        Write-Host 'Nado 服务已停止，浏览器中的钱包数据已保留。'
        exit 0
    }

    $ownedServer = Get-OwnedServer $saved
    $savedMode = if ($saved -and $saved.mode -eq 'online') { 'online' } else { 'offline' }
    $pagePath = if ($Mode -eq 'online') { '/?network=testnet' } else { '/accounts' }
    # Keep the exact origin when switching modes so the browser sees the same vault.
    $portText = if ($null -ne $ownedServer) { [string]$saved.port } elseif ($env:PORT) { $env:PORT } else { '18270' }
    if ($portText -notmatch '^\d+$' -or [double]$portText -lt 1 -or [double]$portText -gt 65535) {
        throw '端口参数 PORT 必须是 1 至 65535 之间的整数。'
    }
    $serverPort = [int]$portText
    $baseUrl = "http://127.0.0.1:$serverPort"
    $url = "$baseUrl$pagePath"
    if ($null -ne $ownedServer -and $savedMode -eq $Mode) {
        $modeLabel = if ($Mode -eq 'online') { '联网' } else { '离线' }
        Write-Host "Nado 已在${modeLabel}模式运行：$url"
        if (-not $NoBrowser) { Start-Process $url }
        exit 0
    }

    $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $nodeCommand) {
        throw '未找到 Node.js。请安装 Node.js 22.12 或更高版本，然后运行 Setup-Nado.cmd。'
    }
    $nodePath = $nodeCommand.Source
    $nodeVersion = & $nodePath -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 无法正常运行，请重新安装后重试。' }
    $versionParts = $nodeVersion.Split('.')
    if ([int]$versionParts[0] -lt 22 -or ([int]$versionParts[0] -eq 22 -and [int]$versionParts[1] -lt 12)) {
        throw "当前 Node.js $nodeVersion 过旧；请安装 22.12 或更高版本。"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $appDir 'node_modules\next\package.json') -PathType Leaf)) {
        throw '缺少项目依赖，请先运行 Setup-Nado.cmd 完成安装。'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $appDir '.next\BUILD_ID') -PathType Leaf)) {
        throw '缺少正式构建文件，请先运行 Setup-Nado.cmd 完成安装与构建。'
    }
    if ($null -ne $ownedServer) {
        $modeLabel = if ($Mode -eq 'online') { '联网' } else { '离线' }
        Write-Host "正在使用原端口 $serverPort 将 Nado 切换为${modeLabel}模式。"
        Stop-OwnedServer $saved
    }
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    if ($listeners | Where-Object { $_.Port -eq $serverPort }) {
        throw "端口 $serverPort 已被占用，无法启动 Nado。"
    }
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $env:PORT = [string]$serverPort
    $env:NADO_LIVE = if ($Mode -eq 'online') { '1' } else { '0' }
    $env:NADO_DEV_SEED = '0'
    $env:NEXT_TELEMETRY_DISABLED = '1'
    $stdoutPath = Join-Path $stateDir 'server.stdout.log'
    $stderrPath = Join-Path $stateDir 'server.stderr.log'
    $serverProcess = Start-Process -FilePath $nodePath -ArgumentList @("`"$entryPath`"", 'start') `
        -WorkingDirectory $appDir -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $saved = [pscustomobject]@{
        pid = $serverProcess.Id
        startedUtc = $serverProcess.StartTime.ToUniversalTime().ToString('o')
        entry = $entryPath
        port = $serverPort
        mode = $Mode
    }
    $saved | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    $ready = $false
    $connected = $false
    $marketCount = 0
    $attemptLimit = if ($Mode -eq 'online') { 3 } else { 30 }
    $requestTimeout = if ($Mode -eq 'online') { 12 } else { 2 }
    for ($attempt = 0; $attempt -lt $attemptLimit; $attempt++) {
        if ($serverProcess.HasExited) { throw "Nado 在启动时退出，请查看日志：$stderrPath" }
        try {
            $response = Invoke-WebRequest "$baseUrl/api/nado/state" -UseBasicParsing -TimeoutSec $requestTimeout
            $payload = $response.Content | ConvertFrom-Json
            if ($response.StatusCode -eq 200) {
                if ($Mode -eq 'offline' -and $payload.enabled -eq $false) { $ready = $true; break }
                if ($Mode -eq 'online' -and $payload.enabled -eq $true) {
                    # A local API response proves the server started. Upstream errors
                    # leave online mode available for the page's bounded retry control.
                    $ready = $true
                    $marketCount = @($payload.markets).Count
                    $connected = -not $payload.error -and $payload.chainId -in @(763373, 57073) `
                        -and [bool]$payload.endpoint -and [bool]$payload.wsSubscribeUrl `
                        -and $null -ne $payload.markets -and $marketCount -gt 0
                    break
                }
            }
        } catch { }
        if ($attempt + 1 -lt $attemptLimit) {
            $retryDelay = if ($Mode -eq 'online') { 2000 } else { 500 }
            Start-Sleep -Milliseconds $retryDelay
        }
    }
    if (-not $ready) {
        Stop-OwnedServer $saved
        throw "Nado 启动检查未通过，请查看日志：$stderrPath"
    }
    $modeLabel = if ($Mode -eq 'online') { '联网' } else { '离线' }
    Write-Host "Nado 已在${modeLabel}模式运行：$url"
    if ($Mode -eq 'online') {
        if ($connected) {
            Write-Host "公共行情连接正常，共 $marketCount 个交易市场。此次启动未提交交易。"
        } else {
            Write-Warning '联网模式已启动，但公共行情连接暂不可用，请打开页面重试。'
        }
        Write-Host '联网入口默认打开测试网，可在页面中切换主网。开发用助记词接口已禁用。'
    } else {
        Write-Host '本地钱包模式：联网交易和开发用助记词接口已禁用。'
    }
    Write-Host '运行 Stop-Nado.cmd 可停止后台服务。'
    if (-not $NoBrowser) { Start-Process $url }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
