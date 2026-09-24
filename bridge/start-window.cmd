@echo off
cd /d "%~dp0"
start "WoW Muse bridge" cmd /k node supervisor.js
