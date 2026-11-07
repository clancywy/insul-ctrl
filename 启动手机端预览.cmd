@echo off
chcp 65001 >nul
title InsulCtrl v4.1.0
cd /d "%~dp0"
echo InsulCtrl v4.1.0
echo 打开本机地址 http://127.0.0.1:4173/insul-ctrl/
echo 如已有旧预览服务占用 4173，请先关闭该服务。
call npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
pause
