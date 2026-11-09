@echo off
setlocal
cd /d "%~dp0"
cls

echo.
echo  ============================================================
echo    Nexi Release - one click, no browser, no OTP
echo  ============================================================
echo.
echo    Stages: redact -^> hygiene -^> tests -^> pack -^> verify -^> publish
echo    Auth  : ~/.npmrc granular token (bypass 2FA)
echo    Takes : about 5 minutes (tests dominate)
echo.
echo  ------------------------------------------------------------
echo.

node tools\release.mjs --publish
set "RC=%ERRORLEVEL%"

echo.
echo  ============================================================
if "%RC%"=="0" (
  echo    [OK] Published and confirmed on the registry.
  echo         Global check:  npm view agentdeck-super version
  echo         Real install:  node tools\dev.mjs --from-registry
) else (
  echo    [X] Stopped with exit code %RC% - read the reason above.
  echo        If it says "being processed", the version is fine:
  echo        npm is still rolling it out. Wait 2-3 minutes.
)
echo  ============================================================
echo.
pause
