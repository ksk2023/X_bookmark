# Wrapper that removes the machine-level Chrome extension policy via UAC.
# Usage:  powershell -ExecutionPolicy Bypass -File .\uninstall-policy.ps1
# (this triggers one Windows UAC prompt; the actual removal runs as admin)
$script = $PSCommandPath ? (Join-Path (Split-Path $PSCommandPath) '_policy_uninstall.ps1') : 'E:\BaiduNetdiskDownload\X_bookmark\_policy_uninstall.ps1'
Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File', $script
$log = Join-Path (Split-Path $script) '_policy_install.log'
if (Test-Path $log) { Get-Content $log }
