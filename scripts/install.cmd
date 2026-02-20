@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
endlocal
