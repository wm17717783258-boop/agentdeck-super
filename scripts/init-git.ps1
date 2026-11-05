<#
.SYNOPSIS
    把这台机器上的 agentdeck-super 变成一个能推到 GitHub 的 git 仓库。

.DESCRIPTION
    四步，每步都会检查是否已经做过，可以反复跑：
      1) 有 git 吗？没有就告诉你一行安装命令（不会自己装）
      2) git init + 首次提交（.gitignore 已就位，不会把 node_modules / 密钥提交进去）
      3) 配置 user.name / user.email（从参数或本地 git 配置读）
      4) 设 origin 并首次推送（仓库必须已经在 GitHub 上建好，空仓库即可）

.EXAMPLE
    # 首次：先装 git（PowerShell 一行）
    winget install --id Git.Git -e

    # 然后在本目录
    .\scripts\init-git.ps1 -Email 你的邮箱@example.com -RepoUrl https://github.com/你的用户名/agentdeck-super

.NOTES
    这个脚本只做「加」和「提交」，不 amend、不 force push、不删任何东西。
#>

[CmdletBinding()]
param(
    [string]$Name = '王冕',
    [string]$Email = '',
    [string]$RepoUrl = '',
    [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
Write-Host "工作目录：$root" -ForegroundColor Cyan

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Good($text) { Write-Host "    ✓ $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    ! $text" -ForegroundColor Yellow }
function Die($text) { Write-Host "    ✗ $text" -ForegroundColor Red; exit 1 }

# ── 1. git 在不在 ────────────────────────────────────────────────────────────
Step '1/4' '检查 git'
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Warn '这台机器上没有 git。装一行就好（装完关掉这个窗口重开，再跑本脚本）：'
    Write-Host ''
    Write-Host '    winget install --id Git.Git -e' -ForegroundColor White
    Write-Host ''
    Write-Host '    没有 winget？到 https://git-scm.com/download/win 下安装包，一路默认即可。'
    exit 0
}
Good "git $((git --version) -replace '^git version ', '') → $($git.Source)"

# ── 2. 仓库 & 忽略清单 ──────────────────────────────────────────────────────
Step '2/4' '初始化仓库'
if (Test-Path (Join-Path $root '.git')) {
    Good '已经是 git 仓库，跳过 init'
} else {
    git init --initial-branch=main | Out-Null
    if ($LASTEXITCODE -ne 0) { git init | Out-Null }
    Good 'git init 完成'
}
if (-not (Test-Path (Join-Path $root '.gitignore'))) { Die '.gitignore 不见了，先把它找回来再继续' }
Good '.gitignore 就位（node_modules / .relay-data / .agentdeck-issuer 都不会被提交）'

# 密钥绝不进仓库：显式再检查一遍，防止有人改过 .gitignore
$dirty = git status --porcelain --ignored=no 2>$null | Select-String -Pattern 'issuer-private|\.pem$|license/key\.txt'
if ($dirty) {
    Warn '暂存区里有疑似密钥文件，先处理掉：'
    $dirty | ForEach-Object { Write-Host "      $_" }
    Die '密钥一旦推上去只能作废重签，别冒这个险'
}
Good '没有密钥类文件混进提交'

# ── 3. 身份 + 首次提交 ─────────────────────────────────────────────────────
Step '3/4' '提交身份与首次提交'
if ($Email) { git config user.email $Email; Good "user.email = $Email" }
elseif (-not (git config user.email 2>$null)) { Warn '没设置 user.email：加 -Email 你的邮箱@example.com 再跑'; exit 1 }
else { Good "user.email = $(git config user.email)" }
if ($Name) { git config user.name $Name; Good "user.name = $Name" }

git add -A
if ($LASTEXITCODE -ne 0) { Die 'git add 失败' }
$staged = (git diff --cached --name-only | Measure-Object -Line).Lines
if ($staged -eq 0) {
    Good '没有新改动，已有提交就是最新的'
} else {
    git commit -m 'feat: agentdeck-super 1.4.x — 异构 Agent 协同 + 跨机房间 + 桌宠分身' | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 'git commit 失败（先看上面的报错）' }
    Good "首次提交完成（$staged 个文件）"
}

# ── 4. 远程与推送 ──────────────────────────────────────────────────────────
Step '4/4' '远端'
if (-not $RepoUrl) {
    Warn '还没给仓库地址。先到 GitHub 建一个空仓库（不要勾 README），然后：'
    Write-Host ''
    Write-Host '    .\scripts\init-git.ps1 -Email 你的邮箱 -RepoUrl https://github.com/你的用户名/agentdeck-super' -ForegroundColor White
    Write-Host ''
    Write-Host '    建好后顺便把 package.json 的仓库链接填真：node tools/set-repo.mjs <同一个地址>'
    exit 0
}
$RepoUrl = $RepoUrl.TrimEnd('/')
if ($RepoUrl -match '^(?!https?://)') { $RepoUrl = "https://$RepoUrl" }
$remotes = git remote
if ($remotes -match '(^|\s)origin(\s|$)') {
    git remote set-url origin $RepoUrl
    Good "origin 已更新为 $RepoUrl"
} else {
    git remote add origin $RepoUrl
    Good "origin 已设为 $RepoUrl"
}
if ($SkipPush) { Warn '按要求跳过推送（-SkipPush）' ; exit 0 }

Write-Host '    首次推送要登录 GitHub（浏览器弹窗或 Personal Access Token），按提示完成即可。'
git push -u origin main
if ($LASTEXITCODE -ne 0) { Die '推送失败：确认仓库已建好且你没勾 "Add README"，或换用 Personal Access Token' }
Good '推送完成'
Write-Host ''
Write-Host "仓库：$RepoUrl" -ForegroundColor White
Write-Host '下一步：node tools/set-repo.mjs ' -NoNewline
Write-Host "$RepoUrl" -ForegroundColor White
Write-Host '然后：node tools/publish-npm.mjs   （干跑体检，全绿再真发）'
