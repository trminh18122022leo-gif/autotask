@echo off
chcp 65001 >nul
title AutoTask AI Workstation v1.1.1
echo ===================================================
echo   AutoTask AI Workstation v1.1.1 - Command Deck
echo ===================================================
echo.
npm start
if errorlevel 1 (
    echo.
    echo Application exited with error code %errorlevel%.
    pause
)
