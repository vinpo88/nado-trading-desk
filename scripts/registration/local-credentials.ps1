# Fixed helper protocol. Secrets arrive only on stdin, never in argv or files.
# No diagnostic output: the caller translates all failures to a fixed code.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false, $true)
$plainBytes = $null
$entropy = $null
$temporaryPath = $null

function Assert-Keys($Value, [string[]]$Keys) {
    if ($null -eq $Value) { throw 'Invalid' }
    $actual = @($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Keys.Count) { throw 'Invalid' }
    foreach ($key in $actual) { if ($Keys -cnotcontains $key) { throw 'Invalid' } }
}
function Assert-Name($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[A-Za-z][A-Za-z0-9_-]{0,63}$') { throw 'Invalid' }
}
function Assert-Path([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer -ne $Directory) { throw 'Invalid' }
}
function Assert-Ancestors([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        Assert-Path $cursor $true
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}
function Set-PrivateAcl([string]$Path, [bool]$Directory, $Sid) {
    Assert-Path $Path $Directory
    if ($Directory) {
        $acl = New-Object Security.AccessControl.DirectorySecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    } else {
        $acl = New-Object Security.AccessControl.FileSecurity
        $inheritance = [Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($Sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($Sid, [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    if ($Directory) { [IO.Directory]::SetAccessControl($Path, $acl) }
    else { [IO.File]::SetAccessControl($Path, $acl) }
}
function Assert-PrivateAcl([string]$Path, [bool]$Directory, $Sid) {
    Assert-Path $Path $Directory
    if ($Directory) { $acl = [IO.Directory]::GetAccessControl($Path) }
    else { $acl = [IO.File]::GetAccessControl($Path) }
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Sid.Value) { throw 'Invalid' }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -lt 1) { throw 'Invalid' }
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -cne $Sid.Value -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'Invalid' }
    }
}
function Assert-Payload($Payload, [string]$Name) {
    Assert-Keys $Payload @('formatVersion', 'credentialName', 'profiles', 'password')
    if ($Payload.formatVersion -ne 1 -or $Payload.credentialName -cne $Name -or $Payload.password -isnot [string] -or
        $Payload.password.Length -lt 8 -or $Payload.password.Length -gt 4096 -or $Payload.password.Contains([char]0)) { throw 'Invalid' }
    if ($Payload.profiles -isnot [Array] -or $Payload.profiles.Count -lt 1 -or $Payload.profiles.Count -gt 32) { throw 'Invalid' }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($profile in $Payload.profiles) { Assert-Name $profile; if (-not $seen.Add($profile)) { throw 'Invalid' } }
}

try {
    $inputText = [Console]::In.ReadToEnd()
    if ($inputText.Length -gt 65536) { throw 'Invalid' }
    $request = ConvertFrom-Json -InputObject $inputText
    $inputText = $null
    if ($request.action -ceq 'store') { Assert-Keys $request @('action', 'repoDir', 'credentialName', 'payload') }
    elseif ($request.action -ceq 'load') { Assert-Keys $request @('action', 'repoDir', 'credentialName') }
    else { throw 'Invalid' }
    Assert-Name $request.credentialName
    if ($request.repoDir -isnot [string] -or -not [IO.Path]::IsPathRooted($request.repoDir)) { throw 'Invalid' }
    $repo = [IO.Path]::GetFullPath($request.repoDir)
    Assert-Ancestors $repo
    $localDir = Join-Path $repo '.local'
    $credentialDir = Join-Path $localDir 'credentials'
    $target = Join-Path $credentialDir ($request.credentialName + '.dpapi')
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    if ($request.action -ceq 'store') {
        foreach ($directory in @($localDir, $credentialDir)) {
            if (-not [IO.Directory]::Exists($directory)) { [void][IO.Directory]::CreateDirectory($directory) }
            Assert-Path $directory $true
        }
        Set-PrivateAcl $credentialDir $true $sid
    }
    Assert-Ancestors $credentialDir
    Assert-PrivateAcl $credentialDir $true $sid
    Add-Type -AssemblyName System.Security
    $binding = 'nado-local-credential-v1' + "`n" + $repo.TrimEnd('\').ToUpperInvariant() + "`n" + $request.credentialName + "`n" + $sid.Value
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $entropy = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($binding)) } finally { $sha.Dispose() }
    if ($request.action -ceq 'store') {
        Assert-Payload $request.payload $request.credentialName
        $plainBytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $request.payload -Depth 5 -Compress))
        $cipher = [Security.Cryptography.ProtectedData]::Protect($plainBytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $temporaryPath = Join-Path $credentialDir ('.' + $request.credentialName + '-' + [Guid]::NewGuid().ToString('N') + '.tmp')
        $stream = New-Object IO.FileStream($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($cipher, 0, $cipher.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Set-PrivateAcl $temporaryPath $false $sid
        Assert-PrivateAcl $temporaryPath $false $sid
        Assert-Ancestors $credentialDir
        if ([IO.File]::Exists($target)) {
            Assert-PrivateAcl $target $false $sid
            [IO.File]::Replace($temporaryPath, $target, [NullString]::Value)
        } else { [IO.File]::Move($temporaryPath, $target) }
        $temporaryPath = $null
        [Console]::Out.Write('{"stored":true}')
    } else {
        Assert-PrivateAcl $target $false $sid
        $info = Get-Item -LiteralPath $target -Force
        if ($info.Length -lt 32 -or $info.Length -gt 65536) { throw 'Invalid' }
        $cipher = [IO.File]::ReadAllBytes($target)
        $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $payload = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString($plainBytes))
        Assert-Payload $payload $request.credentialName
        [Console]::Out.Write((ConvertTo-Json -InputObject $payload -Depth 5 -Compress))
    }
} catch {
    exit 1
} finally {
    if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    if ($null -ne $entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
    if ($temporaryPath -and [IO.File]::Exists($temporaryPath)) {
        try { Assert-Path $temporaryPath $false; [IO.File]::Delete($temporaryPath) } catch {}
    }
    $request = $null
    $payload = $null
}
