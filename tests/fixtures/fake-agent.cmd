@echo off
rem fake CLI shim: cmd.exe wrapper for fake-agent.mjs (ASCII only, CRLF required)
node "%~dp0fake-agent.mjs" %*
