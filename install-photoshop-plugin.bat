@echo off
rem NKD Comfy Bridge: installs the Photoshop plugin that ships in this folder.
rem Double-click it. Photoshop can stay open; restart it afterwards if the panel doesn't show up.
setlocal
set "HERE=%~dp0"
set "CCX=%TEMP%\NKD-Comfy-Bridge.ccx"
set "UPIA=%CommonProgramFiles%\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe"

echo.
echo  NKD Comfy Bridge - Photoshop plugin installer
echo  ---------------------------------------------
echo  Packing the plugin...
if exist "%CCX%" del "%CCX%"
powershell -NoProfile -Command "Compress-Archive -Path '%HERE%photoshop\*' -DestinationPath '%TEMP%\NKD-Comfy-Bridge.zip' -Force; Move-Item -Force '%TEMP%\NKD-Comfy-Bridge.zip' '%CCX%'"
if not exist "%CCX%" (
  echo  [!] Could not pack the plugin. Is the "photoshop" folder next to this file?
  pause & exit /b 1
)

if exist "%UPIA%" (
  rem Updating over an older version leaves BOTH registered and Photoshop keeps loading the old one.
  echo  Removing any previous version...
  "%UPIA%" /remove "NKD Comfy Bridge" >nul 2>&1
  "%UPIA%" /remove "NKD Comfy Bridge" >nul 2>&1
  echo  Installing with Adobe's plugin installer...
  "%UPIA%" /install "%CCX%"
  if not errorlevel 1 (
    echo.
    echo  Done. In Photoshop open:  Plugins ^> NKD Comfy Bridge
    pause & exit /b 0
  )
  echo  [!] Adobe's installer refused it. Trying the Creative Cloud app instead...
)

echo  Opening the plugin with Creative Cloud. Click "Install" in the window that appears.
start "" "%CCX%"
pause
