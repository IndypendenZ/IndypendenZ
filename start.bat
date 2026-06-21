@echo off
REM ดับเบิลคลิกไฟล์นี้บน Windows เพื่อเปิด CryptoDash
cd /d "%~dp0"

echo Starting CryptoDash...

if not exist node_modules (
  echo Installing dependencies for the first time...
  call npm install
)

start "" http://localhost:8080

if exist .env (
  node --env-file=.env server.js
) else (
  node server.js
)
