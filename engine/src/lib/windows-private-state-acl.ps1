param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('repair', 'verify')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$Path,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 4096)]
  [int]$MaxEntries
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

function Stop-PrivateStateAcl {
  throw 'PRIVATE_STATE_ACL_REJECTED'
}

function Get-BoundedPrivateTree {
  param([string]$RootPath, [int]$Limit)

  if (-not [System.IO.Path]::IsPathRooted($RootPath)) {
    Stop-PrivateStateAcl
  }
  $root = Get-Item -LiteralPath $RootPath -Force
  if (-not $root.PSIsContainer -or (($root.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Stop-PrivateStateAcl
  }

  $items = New-Object 'System.Collections.Generic.List[System.IO.FileSystemInfo]'
  $pending = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
  [void]$items.Add($root)
  $pending.Push($root)

  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in (Get-ChildItem -LiteralPath $directory.FullName -Force)) {
      if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        Stop-PrivateStateAcl
      }
      if (-not ($entry -is [System.IO.DirectoryInfo]) -and -not ($entry -is [System.IO.FileInfo])) {
        Stop-PrivateStateAcl
      }
      [void]$items.Add($entry)
      if ($items.Count -gt $Limit) {
        Stop-PrivateStateAcl
      }
      if ($entry -is [System.IO.DirectoryInfo]) {
        $pending.Push($entry)
      }
    }
  }
  return ,$items.ToArray()
}

function New-PrivateAcl {
  param(
    [bool]$Directory,
    [System.Security.Principal.SecurityIdentifier[]]$Allowed
  )

  if ($Directory) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($Allowed[0])
  foreach ($sid in $Allowed) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  return $acl
}

function Test-PrivateAcl {
  param(
    [System.IO.FileSystemInfo]$Item,
    [System.Security.Principal.SecurityIdentifier[]]$Allowed,
    [bool]$RequireProtected
  )

  $current = Get-Item -LiteralPath $Item.FullName -Force
  if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    return $false
  }
  $acl = Get-Acl -LiteralPath $current.FullName
  if ($RequireProtected -and -not $acl.AreAccessRulesProtected) {
    return $false
  }
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $Allowed[0].Value) {
    return $false
  }

  $required = @{}
  foreach ($sid in $Allowed) { $required[$sid.Value] = $false }
  $rules = $acl.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  )
  foreach ($rule in $rules) {
    $identity = $rule.IdentityReference.Value
    if (-not $required.ContainsKey($identity)) { return $false }
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
      return $false
    }
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    if (($rule.FileSystemRights -band $fullControl) -ne $fullControl) {
      return $false
    }
    $required[$identity] = $true
  }
  foreach ($present in $required.Values) {
    if (-not $present) { return $false }
  }
  return $true
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @(
  $currentUser,
  (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),
  (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'))
)
$items = Get-BoundedPrivateTree -RootPath $Path -Limit $MaxEntries

if ($Mode -eq 'repair') {
  foreach ($item in $items) {
    $current = Get-Item -LiteralPath $item.FullName -Force
    if (($current.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      Stop-PrivateStateAcl
    }
    $isDirectory = $current -is [System.IO.DirectoryInfo]
    $acl = New-PrivateAcl -Directory $isDirectory -Allowed $allowed
    Set-Acl -LiteralPath $current.FullName -AclObject $acl
  }
}

for ($index = 0; $index -lt $items.Count; $index++) {
  if (-not (Test-PrivateAcl -Item $items[$index] -Allowed $allowed -RequireProtected $true)) {
    Stop-PrivateStateAcl
  }
}

[ordered]@{
  version = 1
  private = $true
  count = $items.Count
  rootProtected = $true
  principals = @('administrators', 'current-user', 'local-system')
  violations = @()
} | ConvertTo-Json -Compress
