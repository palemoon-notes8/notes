@echo off
title OB Board - keep this window open
cd /d "%~dp0"
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY if exist "%USERPROFILE%\anaconda3\python.exe" set "PY=%USERPROFILE%\anaconda3\python.exe"
if not defined PY if exist "%USERPROFILE%\miniconda3\python.exe" set "PY=%USERPROFILE%\miniconda3\python.exe"
if not defined PY for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%D\python.exe" set "PY=%%D\python.exe"
if not defined PY (
  echo Python is not installed.
  echo Install it from https://www.python.org/downloads/  ^(tick "Add python.exe to PATH"^), then double-click this file again.
  start "" https://www.python.org/downloads/
  pause
  exit /b 1
)
echo Starting OB Board... the browser will open in a few seconds.
echo Keep this window open while you use the board. Close it to stop.
start "" cmd /c "timeout /t 4 >nul & start http://127.0.0.1:8000"
"%PY%" server.py
echo.
echo The board stopped. If you see an error above, send a screenshot to Claude.
pause
