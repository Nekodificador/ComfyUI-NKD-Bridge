# Dev loop: pack ./photoshop, remove every installed copy, install, and print what Photoshop will load.
# Restart Photoshop afterwards. Usage: powershell -File tools\dev_install.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$upia = "$env:CommonProgramFiles\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"
$zip = "$env:TEMP\NKD-Comfy-Bridge.zip"; $ccx = "$env:TEMP\NKD-Comfy-Bridge.ccx"
Remove-Item $zip, $ccx -ErrorAction SilentlyContinue
Compress-Archive -Path "$root\photoshop\*" -DestinationPath $zip
Move-Item $zip $ccx
function Upia($a) {
  $p = Start-Process -FilePath $upia -ArgumentList $a -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\upia_out.txt"
  (Get-Content "$env:TEMP\upia_out.txt") -join ' | '
}
# /install over an older version can leave both registered; Photoshop then loads the old one.
1..3 | ForEach-Object { $null = Upia @('/remove', '"NKD Comfy Bridge"') }
Upia @('/install', "`"$ccx`"")
$reg = Get-Content "$env:APPDATA\Adobe\UXP\PluginsInfo\v1\PS.json" -Raw
$hits = [regex]::Matches($reg, '"versionString":"([^"]+)"[^{}]*?|nkd\.comfy\.bridge_([\d.]+)') | ForEach-Object { $_.Groups[2].Value } | Where-Object { $_ }
"registered: $($hits -join ', ')   (must be exactly one)"
