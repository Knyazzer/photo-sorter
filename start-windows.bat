@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js не найден.
  echo Установите Node.js 22 или новее с https://nodejs.org/
  echo.
  pause
  exit /b 1
)
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 22 (
  echo.
  echo Нужен Node.js 22 или новее. Сейчас установлен Node.js %NODE_MAJOR%.
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\sharp\package.json" (
  echo.
  echo Устанавливаю зависимости Photo Sorter...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Не удалось установить зависимости. Проверьте интернет и повторите запуск.
    pause
    exit /b 1
  )
)
cls
echo Запуск Photo Sorter 2.1...
node server.js
pause
