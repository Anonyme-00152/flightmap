@echo off
setlocal
REM ============================================================================
REM  FlightMap - start.bat : demarre le serveur et ouvre le navigateur.
REM  Options : start.bat 8080      (autre port)
REM            start.bat --dev     (redemarrage automatique quand un fichier change)
REM ============================================================================
cd /d "%~dp0"

if not exist "node_modules\express\package.json" (
  echo [INFO] Dependances absentes : lancement de build.bat d'abord...
  call build.bat --no-test
  if errorlevel 1 exit /b 1
)

set PORT=3000
set MODE=start
for %%A in (%*) do (
  if /I "%%A"=="--dev" set MODE=dev
  echo %%A| findstr /r "^[0-9][0-9]*$" >nul && set PORT=%%A
)

echo.
echo  FlightMap sur http://localhost:%PORT%   ^(Ctrl+C pour arreter^)
echo.
start "" "http://localhost:%PORT%"
if "%MODE%"=="dev" (
  call npm run dev
) else (
  call npm start
)
endlocal
