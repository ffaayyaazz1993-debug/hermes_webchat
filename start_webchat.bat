@echo off
REM Hermes Web Chat launcher -- starts the local web UI for the existing Hermes agent.
REM Usage:  start_webchat.bat  [--port 8787] [--open]
setlocal
set "HERE=%~dp0"
set "PY=C:\Users\ffaay\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe"
if not exist "%PY%" (
  echo Could not find the Hermes venv python at:
  echo   %PY%
  echo Run "hermes doctor" to repair the installation.
  exit /b 1
)
REM Keeps hermes_bootstrap from relaunching server.py under an interpreter that lacks
REM Hermes' dependencies (see server.py _bootstrap_import_path).
set "HERMES_DISABLE_LAZY_INSTALLS=1"
"%PY%" "%HERE%server.py" %*
endlocal
