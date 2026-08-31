@echo off
rem AgentWorkShop dev server 常驻窗口(独立于 agent 会话,可随时关闭窗口停止)
cd /d D:\codes\ABO\AgentWorkShop
title AW dev server :3000
npm run dev
pause
