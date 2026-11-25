@echo off
chcp 65001 >nul
title AutoTask AI Workstation v1.1.7-rc.2
echo =====================================================
echo   AutoTask AI Workstation v1.1.7-rc.2 - Command Deck
echo =====================================================
echo.
if exist "%~dp0resources\certs\globalsign_intermediate.crt" (
    set "NODE_EXTRA_CA_CERTS=%~dp0resources\certs\globalsign_intermediate.crt"
) else if exist "%~dp0resources\certs\globalsign_intermediate.pem" (
    set "NODE_EXTRA_CA_CERTS=%~dp0resources\certs\globalsign_intermediate.pem"
) else if exist "%~dp0.private\globalsign_intermediate.pem" (
    set "NODE_EXTRA_CA_CERTS=%~dp0.private\globalsign_intermediate.pem"
)
npm start
if errorlevel 1 (
    echo.
    echo Application exited with error code %errorlevel%.
    pause
)
