@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js kurulu degil. https://nodejs.org adresinden LTS surumunu kur, sonra tekrar calistir.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Paketler kuruluyor, bu sadece ilk seferde olur...
  call npm install
  if errorlevel 1 (
    echo Kurulum basarisiz oldu.
    pause
    exit /b 1
  )
)
call npm start
