#!/usr/bin/env node
/**
 * tools/verify-installed-security.mjs —— 在"真的装进 profile 的那份"上重放攻击
 *
 * 为什么还要这一份：跑仓库里的测试只能证明**源码**挡住了。
 * 用户真正装的是 `~/.dsh/profiles/<profile>/node_modules/agentdeck-super` 里的那份，
 * 所以这里直接 import 装好的 lib，原样重放两条越权攻击，写成证据。
 *
 * 跑法：node tools/verify-installed-security.mjs
 * 参数：环境变量 NEXI_PROFILE 指定 profile（默认 web）
 */

import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROFILE = process.env.NEXI_PROFILE || 'web'
const PKG = join(homedir(), '.dsh', 'profiles', PROFILE, 'node_modules', 'agentdeck-super')
const EVID = join(process.cwd(), 'docs', 'evidence')
const rows = []
let failed = 0

function check(label, ok, detail = '') {
  rows.push(`${ok ? '✔' : '✖'} ${label}${detail ? ` —— ${detail}` : ''}`)
  if (!ok) failed += 1
}

async function main() {
  const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
  const adbpFile = join(PKG, 'lib', 'engine', 'adbp.js')
  const adbpHash = createHash('sha256').update(readFileSync(adbpFile)).digest('hex').toUpperCase()

  const { createBoard } = await import(pathToFileURL(join(PKG, 'lib', 'engine', 'board.js')).href)
  const { createIngress } = await import(pathToFileURL(adbpFile).href)

  const root = mkdtempSync(join(tmpdir(), 'nexi-installed-sec-'))
  try {
    const FIXED = new Date(2026, 10, 1, 9, 0, 0)
    const now = () => FIXED
    const board = createBoard({ root, now })
    const teamA = board.createTeam({ name: '装好的 A 队', goal: '正常活' })
    const teamB = board.createTeam({ name: '装好的 B 队', goal: '机密：定价表' })
    board.addTask(teamA.id, { title: 'A 队：写登录页' })
    board.addTask(teamB.id, { title: 'B 队：机密定价表复核' })

    const ingress = createIngress({ board, teamId: teamA.id, name: 'installed-check' })
    const hello = await ingress.handler('POST', '/adbp/v1/hello', { name: '远程工位', kind: 'adbp' })
    check('装好的这份能正常签发令牌', hello?.status === 200, `HTTP ${hello?.status}`)
    const headers = { authorization: `Bearer ${hello.json.token}` }

    const own = await ingress.handler('GET', '/adbp/v1/state', null, headers)
    check('自己团队照常读得到（没把正常路堵死）', own.status === 200, `HTTP ${own.status}`)

    const cross = await ingress.handler('GET', `/adbp/v1/state?teamId=${teamB.id}`, null, headers)
    const crossBlob = JSON.stringify(cross.json)
    check('攻击 1：拿 A 队令牌读 B 队任务板被挡住', cross.status === 403 && cross.json.error === 'forbidden', `HTTP ${cross.status} ${cross.json.error || ''}`)
    check('攻击 1 的响应里没有 B 队内容', !crossBlob.includes('机密定价表') && !crossBlob.includes(teamB.id), `${crossBlob.length} 字节响应`)

    const other = await ingress.handler('POST', '/adbp/v1/hello', { name: '另一个工位', kind: 'adbp' })
    const spoof = await ingress.handler('POST', '/adbp/v1/result', { taskId: 'task_whatever', memberId: other.json.memberId, output: '替别人交活' }, headers)
    check('攻击 2：冒用别人 memberId 交活被挡住', spoof.status === 403 && spoof.json.error === 'forbidden', `HTTP ${spoof.status}`)

    const spoofChat = await ingress.handler('POST', '/adbp/v1/chat', { memberId: other.json.memberId, text: '冒名说话' }, headers)
    check('攻击 3：冒用别人 memberId 发言被挡住', spoofChat.status === 403, `HTTP ${spoofChat.status}`)

    const fake = await ingress.handler('GET', '/adbp/v1/state', null, { authorization: 'Bearer deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
    check('攻击 4：编造的令牌进不来', fake.status === 401, `HTTP ${fake.status}`)
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }

  const text = [
    '# 装进 profile 的那份 1.7.2，当场重放越权攻击',
    '',
    `· 时间：${new Date().toISOString()}（本机时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}）`,
    `· 安装位置：${PKG}`,
    `· 磁盘版本：${pkg.version}`,
    `· lib/engine/adbp.js SHA256：${adbpHash}`,
    `· 结果：${rows.filter((r) => r.startsWith('✔')).length} 过 / ${failed} 失败`,
    '',
    '说明：这里 import 的是**装好的那份** lib（不是仓库源码），重放同样的攻击，',
    '证明修好的代码真的已经在用户会用到的那份里，不只是躺在仓库里。',
    '',
    ...rows,
    '',
  ].join('\n')

  mkdirSync(EVID, { recursive: true })
  const file = join(EVID, `installed-security-${pkg.version}.txt`)
  writeFileSync(file, text, 'utf8')
  console.log(text)
  console.log(`→ ${file}`)
  if (failed) process.exitCode = 1
}

main().catch((err) => {
  console.error('[installed-security] 失败：', err?.stack || err)
  process.exitCode = 1
})
