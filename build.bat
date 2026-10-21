@echo off
setlocal EnableExtensions
REM ============================================================================
REM  FlightMap - build.bat (Windows)
REM  Installe tout ce qu'il faut et verifie que ca marche :
REM    1. Node.js >= 22.13 present ?
REM    2. dependances (npm install)      - saute si node_modules existe deja
REM    3. referentiel (npm run setup-data) - saute si data/airports.json existe
REM    4. icones PWA (npm run icons)     - saute si deja generees
REM    5. .env cree depuis .env.example si absent
REM    6. tests (npm test)
REM  Options :  build.bat --force   (refait tout)     build.bat --no-test
REM  Ensuite : start.bat
REM ============================================================================
cd /d "%~dp0"

set FORCE=0
set NOTEST=0
for %%A in (%*) do (
  if /I "%%A"=="--force" set FORCE=1
  if /I "%%A"=="--no-test" set NOTEST=1
)

echo.
echo  ==============================
echo   FlightMap - installation
echo  ==============================
echo.

REM --- 1. Node ----------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERREUR] Node.js est introuvable. Installe la version LTS : https://nodejs.org
  echo          puis relance build.bat
  exit /b 1
)
for /f "tokens=1 delims=v" %%V in ('node -v') do set NODEVER=%%V
for /f "tokens=1,2 delims=." %%A in ("%NODEVER%") do (
  set NODEMAJ=%%A
  set NODEMIN=%%B
)
echo  Node.js v%NODEVER%
if %NODEMAJ% LSS 22 (
  echo [ERREUR] Node.js 22.13 ou plus est requis ^(SQLite integre^). Version actuelle : v%NODEVER%
  exit /b 1
)
if %NODEMAJ% EQU 22 if %NODEMIN% LSS 13 (
  echo [ERREUR] Node.js 22.13 ou plus est requis. Version actuelle : v%NODEVER%
  exit /b 1
)

REM --- 2. Dependances -----------------------------------------------------------
if %FORCE%==1 goto :install
if exist "node_modules\express\package.json" if exist "node_modules\leaflet\package.json" (
  echo  Dependances : deja installees ^(node_modules^)
  goto :data
)
:install
echo  Installation des dependances ^(express, leaflet^)...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [ERREUR] npm install a echoue.
  exit /b 1
)

REM --- 3. Referentiel -------------------------------------------------------------
:data
if %FORCE%==1 goto :setupdata
if exist "data\airports.json" if exist "data\runways.json" if exist "data\notable.json" (
  echo  Referentiel : deja present ^(data\^)
  goto :icons
)
:setupdata
echo  Telechargement du referentiel ^(aeroports, pistes, appareils remarquables ~15 Mo^)...
call npm run setup-data
if errorlevel 1 (
  echo [ATTENTION] Le referentiel n'a pas pu etre telecharge ^(pas de reseau ?^).
  echo             Le site marche quand meme, sans noms d'aeroports ni pistes. Relance plus tard.
)

REM --- 4. Icones PWA ------------------------------------------------------------
:icons
if %FORCE%==0 if exist "public\icons\icon-512.png" (
  echo  Icones PWA : deja generees
  goto :env
)
echo  Generation des icones PWA...
call npm run icons

REM --- 5. .env ------------------------------------------------------------------
:env
if exist ".env" (
  echo  Configuration : .env present
) else (
  copy /y ".env.example" ".env" >nul
  echo  Configuration : .env cree depuis .env.example ^(ouvre-le pour ajouter tes cles, facultatif^)
)

REM --- 6. Tests -----------------------------------------------------------------
if %NOTEST%==1 goto :done
echo.
echo  Tests...
call npm test
if errorlevel 1 (
  echo [ATTENTION] Des tests ont echoue. Le site peut quand meme demarrer ^(start.bat^).
) else (
  echo  Tests : OK
)

:done
echo.
echo  ==============================
echo   Termine. Lance :  start.bat
echo   puis ouvre  http://localhost:3000
echo  ==============================
echo.
endlocal
exit /b 0
