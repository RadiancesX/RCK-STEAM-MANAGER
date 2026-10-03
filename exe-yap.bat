@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js kurulu degil. https://nodejs.org adresinden LTS surumunu kur.
  pause
  exit /b 1
)
call npm install
call npm run dist
echo.
echo Bittiyse exe dosyasi "dist" klasorunde.
pause
