<#
.SYNOPSIS
    一条命令走完「改版本 → 全量测试 → 端到端 → 打包 → 装进隔离 profile」。

.DESCRIPTION
    这是发版前的固化流程，避免手滑（漏测试、漏打包、装的是旧 tarball）。
    任何一步红了就停，不会继续往下走。

    五个步骤：
      1) 改版本号（可选，-Version patch/minor/major/x.y.z）
      2) 全量测试（串行，281 条）
      3) 端到端自检（5 步，会写一份 docs/evidence/e2e-local-*.md）
      4) npm pack 出 tarball
      5) 装进隔离 profile（默认 agentdecktest，绝不碰 desktop）

.EXAMPLE
    .\scripts\release.ps1                      # 不改版本，只验+打包+装机
    .\scripts\release.ps1 -Version patch       # 1.4.0 → 1.4.1 再验
    .\scripts\release.ps1 -SkipInstall         # 只验+打包

.NOTES
    装机用的是 DSH 自己的 `plugin add`，装的是 tarball（不是 link 源码目录），
    所以能证明"用户拿到的包真能装"。
#>

[CmdletBinding()]
param(
    [string]$Version = '',
    [string]$Profile = 'agentdecktest',
    [switch]$SkipInstall,
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

# dsh 与 pnpm 的定位（别指望它们在 PATH 上）：
#   - dsh 一般在 node 的全局 bin 目录（`dsh.cmd`）；
#   - `dsh plugin add` 会把参数转给 pnpm，pnpm 找不到就直接退 127（"pnpm was not recognized"）。
#     所以装机前先确保 PATH 里有一个能用的 pnpm：优先真装的，其次 DSH 运行时自带的那份（corepack 兜底）。
$dsh = (Get-Command dsh -ErrorAction SilentlyContinue).Source
if (-not $dsh) { $dsh = 'C:\Users\王冕\Apps\nodejs\dsh.cmd' }

function Resolve-PnpmShim {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { return $null }   # 本来就有，不用管
    $candidates = @()
    $runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
    if (Test-Path $runtimes) {
        $candidates += Get-ChildItem -Path $runtimes -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'dependencies\pnpm\bin\pnpm.mjs' } |
            Where-Object { Test-Path $_ }
    }
    $pnpmMjs = $candidates | Select-Object -First 1
    if ($pnpmMjs) {
        # cmd.exe 的 .cmd 里不能出现中文（本机用户目录就是中文名），一律换成 %USERPROFILE%，
        # 这样 shim 是纯 ASCII，不依赖任何代码页。
        $script = $pnpmMjs
        if ($env:USERPROFILE) { $script = $script.Replace($env:USERPROFILE, '%USERPROFILE%') }
        if (-not $script.StartsWith('%')) {
            Write-Host "    ! pnpm 路径含非 ASCII 且不在用户目录下，无法安全写成 shim：$pnpmMjs" -ForegroundColor Yellow
            return $null
        }
        $shimDir = Join-Path $env:TEMP 'adsk-pnpm-shim'
        New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
        Set-Content -Path (Join-Path $shimDir 'pnpm.cmd') -Encoding ascii -Value "@echo off`r`nnode `"$script`" %*"
        Write-Host "    · 用 $pnpmMjs 当 pnpm（临时 shim：$shimDir）" -ForegroundColor DarkGray
        return $shimDir
    }
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        $shimDir = Join-Path $env:TEMP 'adsk-pnpm-shim'
        New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
        Set-Content -Path (Join-Path $shimDir 'pnpm.cmd') -Encoding ascii -Value "@echo off`r`ncorepack pnpm %*"
        Write-Host "    · 用 corepack 提供 pnpm（首次会联网下载，临时 shim：$shimDir）" -ForegroundColor DarkGray
        return $shimDir
    }
    Write-Host '    ! PATH 上没有 pnpm，也没找到 DSH 运行时自带的 pnpm 或 corepack；装机这步会失败' -ForegroundColor Yellow
    return $null
}

function Step($n, $text) { Write-Host "`n[$n/5] $text" -ForegroundColor Cyan }
function Good($text) { Write-Host "    ✓ $text" -ForegroundColor Green }
function Die($text) { Write-Host "    ✗ $text" -ForegroundColor Red; exit 1 }

Write-Host "agentdeck-super 发版流水线 · 目录 $root" -ForegroundColor Cyan

# ── 1. 版本 ─────────────────────────────────────────────────────────────────
Step 1 '版本号'
# 先把宿主版本探出来给 bump-version 用（PATH 上没 dsh 也能写对 compatibility）
$hostVersion = ''
try { $hostVersion = ((& $dsh --version) 2>$null | Select-Object -First 1) } catch { $hostVersion = '' }
if ($hostVersion) {
    $env:AGENTDECK_HOST_VERSION = "$hostVersion".Trim()
    $env:AGENTDECK_DSH_BIN = $dsh
    Write-Host "    · 宿主版本 $($env:AGENTDECK_HOST_VERSION)" -ForegroundColor DarkGray
}
if ($Version) {
    node scripts/bump-version.mjs $Version
    if ($LASTEXITCODE -ne 0) { Die '改版本失败' }
} else {
    $v = (node -e "process.stdout.write(require('./package.json').version)").Trim()
    Good "不改版本，当前 $v"
}

# ── 2. 全量测试 ─────────────────────────────────────────────────────────────
Step 2 '全量测试（串行）'
if ($SkipTests) {
    Write-Host '    跳过（-SkipTests）' -ForegroundColor Yellow
} else {
    $t0 = Get-Date
    node --test --test-concurrency=1 "tests/*.test.mjs" 2>&1 | Tee-Object -Variable testOut | Out-Null
    $last = ($testOut | Select-String -Pattern '^ℹ (tests|pass|fail) ' | Select-Object -Last 3) -join ' / '
    if ($LASTEXITCODE -ne 0) {
        $testOut | Select-Object -Last 25 | ForEach-Object { Write-Host "      $_" }
        Die '测试没过'
    }
    Good ("{0}（{1:N1}s）" -f ($last -replace 'ℹ ', ''), ((Get-Date) - $t0).TotalSeconds)
}

# ── 3. 端到端 ───────────────────────────────────────────────────────────────
Step 3 '端到端自检（5 步，产出一份证据）'
if ($SkipTests) {
    Write-Host '    跳过（-SkipTests）' -ForegroundColor Yellow
} else {
    node tests/e2e-local.mjs 2>&1 | Tee-Object -Variable e2eOut | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $e2eOut | Select-Object -Last 30 | ForEach-Object { Write-Host "      $_" }
        Die '端到端没过'
    }
    $summary = ($e2eOut | Select-String -Pattern '汇总' | Select-Object -Last 1)
    $evidence = ($e2eOut | Select-String -Pattern '证据：' | Select-Object -Last 1)
    Good ($summary -replace '^.*汇总：', '')
    if ($evidence) { Write-Host "      $($evidence.Line.Trim())" }
}

# ── 4. 打包 ─────────────────────────────────────────────────────────────────
Step 4 'npm pack'
$packJson = node -e "const {execFileSync}=require('child_process');const out=execFileSync(process.execPath,['C:/Users/王冕/Apps/nodejs/node_modules/npm/bin/npm-cli.js','pack','--json'],{encoding:'utf8'});process.stdout.write(out)" 2>&1
if ($LASTEXITCODE -ne 0 -or -not $packJson) { Die "打包失败：$packJson" }
$packInfo = ($packJson | ConvertFrom-Json)[0]
$tgz = Join-Path $root $packInfo.filename
if (-not (Test-Path $tgz)) { Die "没找到 tarball：$tgz" }
Good ("{0} · {1} 个文件 · {2:N0} KiB" -f $packInfo.filename, $packInfo.entryCount, ($packInfo.size / 1024))

# ── 5. 装机 ─────────────────────────────────────────────────────────────────
Step 5 "装进隔离 profile：$Profile"
if ($SkipInstall) {
    Write-Host '    跳过（-SkipInstall）' -ForegroundColor Yellow
} else {
    if ($Profile -eq 'desktop') { Die '拒绝装进 desktop（那是日常在用的 profile），换个名字' }
    $shim = Resolve-PnpmShim
    if ($shim) { $env:PATH = "$shim;$env:PATH" }
    & $dsh plugin --profile $Profile add $tgz 2>&1 | ForEach-Object { Write-Host "      $_" }
    if ($LASTEXITCODE -ne 0) { Die '装机失败' }
    $installed = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules\agentdeck-super\package.json"
    if (-not (Test-Path $installed)) { Die "装完没找到 $installed" }
    $iv = (Get-Content $installed -Raw | ConvertFrom-Json).version
    if ($iv -ne $packInfo.version) { Die "装上的版本是 $iv，tarball 是 $($packInfo.version)" }
    Good "已安装 agentdeck-super@$iv（真目录，非软链）"
}

Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host "  node tools/publish-npm.mjs                 # 五关体检（干跑）"
Write-Host "  node tools/publish-npm.mjs --publish       # 真发（要 NPM_TOKEN）"
Write-Host "  dsh plugin --profile agentdecktest add agentdeck-super   # 从公网装一遍（发布后自测）"
