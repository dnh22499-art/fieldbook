@echo off
REM Runs Fieldbook on this Windows PC - needs Node.js 22.13+ (https://nodejs.org).
REM Then open http://localhost:8080
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
node --disable-warning=ExperimentalWarning server\index.js
pause
