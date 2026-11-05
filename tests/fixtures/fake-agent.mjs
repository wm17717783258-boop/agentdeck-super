#!/usr/bin/env node
/**
 * tests/fixtures/fake-agent.mjs —— 假 CLI Agent，专供单测用。
 *
 * 为什么要有它：接入层要验"参数怎么拼、输出怎么解析、超时怎么杀、取消怎么杀"，
 * 这些必须能在不看模型、不烧额度的情况下跑一遍。任何测试都不许调用真实
 * claude / codex / dsh / gemini —— 既慢又贵，还会因为额度/网络红一片。
 *
 * 用法（全部通过参数或环境变量控制，不联网、不读用户配置）：
 *   node fake-agent.mjs --mode echo  --text "你好"
 *   node fake-agent.mjs --mode claude --text "你好"       # 模拟 claude -p --output-format json
 *   node fake-agent.mjs --mode dsh    --text "你好"       # 模拟 dsh headless --json 的 NDJSON
 *   node fake-agent.mjs --mode codex  --text "你好"       # 模拟 codex exec 的纯文本 + tokens used
 *   node fake-agent.mjs --mode gbk                        # 输出 GBK 字节，验编码兜底
 *   node fake-agent.mjs --mode stderr                     # 只往 stderr 写并退出码 3
 *   node fake-agent.mjs --mode sleep --sleep 5000         # 睡够时间（验超时）
 *   node fake-agent.mjs --mode tree --pidfile <path>      # 再拉一个孙进程（验进程树杀）
 *   node fake-agent.mjs --mode chunk --text 你好           # 分片输出（验 onChunk）
 *   node fake-agent.mjs --version                        # 版本探测
 * 如果不传 --text，就用 stdin 的内容（真实 CLI 的 stdin 型走法）。
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

function flag(name, fallback = '') {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
}

const has = (name) => argv.includes(name);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

const mode = flag('--mode', 'echo');
const tag = flag('--tag', 'p');
const sleepMs = Number(flag('--sleep', '0')) || 0;

if (mode === 'version') {
  process.stdout.write('fake-agent 9.9.9\n');
  process.exit(0);
}

// 把真实收到的参数原样吐出来：用来验证参数模板 / 只读化改写到底拼成了什么
if (mode === 'argv') {
  process.stdout.write(JSON.stringify(argv) + '\n');
  process.exit(0);
}

let prompt = flag('--text', '');
if (!prompt) {
  // 真实 CLI：提示词可能走 stdin（claude -p / codex exec - / dsh headless -）或末尾位置参数
  const last = argv[argv.length - 1];
  prompt = (await readStdin()) || (last && !last.startsWith('--') ? last : '');
}

const reply = `FAKE[${tag}] 收到:${prompt || 'EMPTY'}`;
const out = (s) => process.stdout.write(s);

switch (mode) {
  case 'echo':
    out(reply + '\n');
    break;

  case 'chunk': {
    for (const piece of ['第一段', '第二段', '第三段']) {
      out(piece);
      await new Promise((r) => setTimeout(r, 30));
    }
    out('\n');
    break;
  }

  case 'claude': {
    // 真实 claude 会在 JSON 前先打一行自己的日志：故意保留，验证"从后往前找 JSON"
    out('[claude-code:unrecognized_model] {"model":"fake"}\n');
    out(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: reply,
        session_id: 'sess-fake-1',
        modelUsage: { 'fake-claude-4': { inputTokens: 11, outputTokens: 22, costUSD: 0.007 } },
      }) + '\n',
    );
    break;
  }

  case 'dsh': {
    const events = [
      { type: 'session', sessionId: 'dsh-sess-1' },
      { type: 'status', usage: { inputTokens: 7, outputTokens: 3, model: 'dsh-chat' } },
      { type: 'final', text: reply, stopReason: 'end_turn' },
    ];
    for (const ev of events) out(JSON.stringify(ev) + '\n');
    break;
  }

  case 'codex': {
    out(`${reply}\n\n`);
    out('tokens used\n12,547\n');
    break;
  }

  case 'gbk': {
    // "中文" 的 GBK 编码：D6 D0 CE C4（Windows 控制台老程序就这么输出）
    process.stdout.write(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
    break;
  }

  case 'stderr': {
    process.stderr.write('假 CLI 的 stderr：中文报错\n');
    process.exitCode = 3;
    break;
  }

  case 'sleep': {
    await new Promise((r) => setTimeout(r, sleepMs || 5000));
    out(reply + '\n');
    break;
  }

  case 'tree': {
    // 拉一个孙进程并且不退出：用来验证 taskkill /T 真的把整棵树都杀了
    const pidfile = flag('--pidfile', '');
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (pidfile) writeFileSync(pidfile, String(grandchild.pid), 'utf8');
    out(`spawned ${grandchild.pid}\n`);
    await new Promise(() => {});
    break;
  }

  default:
    process.stderr.write(`未知 mode: ${mode}\n`);
    process.exitCode = 2;
}
