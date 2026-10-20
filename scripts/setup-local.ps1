param(
    [switch] $CheckOnly
)

$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repoDir 'apps\console'
$templatePath = Join-Path $appDir '.env.example'
$personalEnvPath = Join-Path $appDir '.env.local'

function Get-RequiredCommand([string] $Name, [string] $Guidance) {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) { throw $Guidance }
    return $command.Source
}

function Test-RepositoryServerRunning {
    # Examine only Node command lines, never browser profiles or environment files.
    $processes = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
    foreach ($process in $processes) {
        $commandLine = $process.CommandLine
        if (-not $commandLine) { continue }
        $inThisRepo = $commandLine.IndexOf($repoDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
        if ($inThisRepo -and $commandLine -match '(?:run-next\.mjs|next[/\\]dist[/\\]bin[/\\]next)(?:["\s]|$)') {
            return $true
        }
    }
    return $false
}

function Assert-RepositoryServerStopped {
    if (Test-RepositoryServerRunning) {
        throw '本仓库的 Nado 服务正在运行。请先通过 Stop-Nado.cmd 或原启动终端停止服务，再安装依赖或构建。安装器不会停止服务。'
    }
}

function Invoke-PinnedPnpm([string[]] $Arguments) {
    # npm ships with Node. No global pnpm installation or Corepack shim is required.
    & $npmPath exec --yes "--package=$packageManager" -- pnpm @Arguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm $($Arguments -join ' ') 未完成，请检查上方提示后重试。" }
}

try {
    $nodePath = Get-RequiredCommand 'node.exe' '未找到 Node.js。请从 https://nodejs.org 安装 Node.js 22.12 或更高版本，并重新打开安装窗口。'
    $npmPath = Get-RequiredCommand 'npm.cmd' '未找到 npm.cmd。请安装带有 npm 的 Node.js，并确认已加入 PATH。'
    $gitPath = Get-RequiredCommand 'git.exe' '未找到 Git。请先安装 Git for Windows，并使用 git clone 获取完整仓库。'
    $runtimeJson = & $nodePath -p 'JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})'
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 无法正常运行。' }
    $runtime = $runtimeJson | ConvertFrom-Json
    $versionParts = $runtime.version.Split('.')
    if ([int]$versionParts[0] -lt 22 -or ([int]$versionParts[0] -eq 22 -and [int]$versionParts[1] -lt 12)) {
        throw "当前 Node.js $($runtime.version) 过旧；本项目要求 22.12 或更高版本。"
    }
    if ($runtime.platform -ne 'win32' -or $runtime.arch -notin @('x64', 'arm64')) {
        throw '此安装入口支持 64 位 Windows（x64 或 ARM64），请安装相应架构的 Node.js。'
    }
    $npmVersion = & $npmPath --version
    if ($LASTEXITCODE -ne 0) { throw 'npm 无法正常运行。' }
    $gitVersion = & $gitPath --version
    if ($LASTEXITCODE -ne 0) { throw 'Git 无法正常运行。' }
    $manifest = Get-Content -LiteralPath (Join-Path $repoDir 'package.json') -Raw | ConvertFrom-Json
    $packageManager = [string]$manifest.packageManager
    if ($packageManager -notmatch '^pnpm@\d+\.\d+\.\d+$') {
        throw 'package.json 必须指定固定版本的 pnpm（例如 pnpm@11.9.0）。'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoDir 'pnpm-lock.yaml') -PathType Leaf)) {
        throw '缺少 pnpm-lock.yaml，请重新获取完整源码。'
    }
    if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) {
        throw '缺少 apps/console/.env.example，请重新获取完整源码。'
    }

    Write-Host "Node.js $($runtime.version) / $($runtime.arch)"
    Write-Host "npm $npmVersion / $gitVersion"
    Write-Host "固定包管理器：$packageManager（通过 npm exec 使用）"
    if (Test-Path -LiteralPath $personalEnvPath) {
        Write-Host '已有 apps/console/.env.local，将保留原文件，不读取或覆盖。'
    } else {
        Write-Host '安装时将从公开模板创建 apps/console/.env.local。'
    }
    if ($CheckOnly) {
        $serverState = if (Test-RepositoryServerRunning) { '正在运行，实际安装前需先停止' } else { '未检测到运行中的服务' }
        Write-Host "本仓库服务：$serverState"
        Write-Host '预检通过。本次未安装依赖、构建、创建配置或启动服务。'
        exit 0
    }

    Assert-RepositoryServerStopped
    Write-Host '开始安装锁定版本的依赖，需要访问 npm 软件源。已有钱包保存在浏览器中，不会由安装器修改。'
    Push-Location -LiteralPath $repoDir
    try {
        Invoke-PinnedPnpm -Arguments @('install', '--frozen-lockfile')
        Assert-RepositoryServerStopped
        if (-not (Test-Path -LiteralPath $personalEnvPath)) {
            # overwrite:false also protects a file created concurrently by the user.
            [System.IO.File]::Copy($templatePath, $personalEnvPath, $false)
            Write-Host '已从公开模板创建 apps/console/.env.local。'
        }
        $env:NADO_LIVE = '0'
        $env:NADO_DEV_SEED = '0'
        $env:NEXT_TELEMETRY_DISABLED = '1'
        Write-Host '开始正式构建。安装结束后由你选择联网或离线启动。'
        Invoke-PinnedPnpm -Arguments @('build')
        if (-not (Test-Path -LiteralPath (Join-Path $appDir '.next\BUILD_ID') -PathType Leaf)) {
            throw '构建命令结束，但未找到正式构建文件，请检查构建输出。'
        }
    } finally {
        Pop-Location
    }
    Write-Host '安装完成。双击 Start-Nado-Online.cmd 联网启动，或 Start-Nado-Offline.cmd 离线启动。'
    Write-Host '默认地址：http://127.0.0.1:18270。未自动启动或停止任何服务。'
    Write-Host '新电脑的钱包请通过加密备份和原保险库密码恢复；源码不包含浏览器钱包。'
    Write-Host 'WalletConnect 公开 Project ID 可以在“连接 Nado 官网”页面填写。'
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
