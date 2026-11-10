/**
 * lib/connect/exec.js —— 起第三方 CLI 时唯一的出口。
 *
 * 为什么单独抽出来：
 *
 *   ① **Windows 上的 .cmd 垫片必须过 shell**，而 `spawnSync(cmd, args, {shell:true})`
 *      是把参数拼成一条命令行交给 cmd.exe —— 参数里有空格会断开、有 `&` `|` `>`
 *      会被当成命令分隔符。npm 全局装的东西常常在
 *      `C:\Users\有 空格\AppData\...` 下面，等于一装就废，甚至变成命令注入。
 *   ② 拼命令行这件事必须**只有一处实现**，否则某个调用点改对了、另一个还是老样子。
 *
 * 策略（保守优先）：
 *   · POSIX → 直接 exec，永不过 shell；
 *   · Windows + .exe → 直接 exec；
 *   · Windows + .cmd/.bat → 自己拼一条**每个参数都加引号**的命令行交给 cmd.exe /d /s /c；
 *   · 参数里出现无法安全转义的字符（`%` 会被 cmd 展开、换行会把命令截断）→
 *     直接判 unsafe，让调用方退回"写配置文件"那条路，绝不硬着头皮拼。
 */

import { spawnSync } from 'node:child_process';

/**
 * 交给 .cmd 垫片时**绝对不能出现**的字符。
 *
 * 为什么连引号包住都不够：npm 生成的垫片里写的是
 *     node "%~dp0\..\tool.js" %*
 * `%*` 是**原样展开**，展开之后 cmd 会**再解析一遍**元字符 —— 也就是说
 * 父进程加的那对引号在垫片里已经被剥掉了，`&` 又变回命令分隔符。
 * 这是我们控制不了的（垫片是别人写的），所以唯一稳的做法是：这些字符一个都不放行，
 * 让调用方退回"直接写配置文件"那条路。
 */
const CMD_UNSAFE = /[%&|<>^\r\n\0]/;

/**
 * 单个参数在 cmd 命令行里的写法。
 * 规则：空串给 `""`；不含特殊字符原样给；否则用双引号包住，内部的 `"` 写成 `""`。
 * （cmd 解析引号时 `""` 表示一个字面双引号，这是 Windows 上通行的写法。）
 */
export function quoteWindowsArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (!/[\s"&|<>^()!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** 把 argv 拼成 cmd.exe 能吃的一整行。 */
export function buildWindowsCommandLine(argv) {
  return argv.map(quoteWindowsArg).join(' ');
}

/** 这些参数交给 cmd 会不会被曲解。返回 null 表示安全，否则返回原因。 */
export function unsafeArgsReason(args = []) {
  for (const a of args) {
    if (CMD_UNSAFE.test(String(a))) {
      return '参数里有 cmd 会二次解析的字符（& | < > ^ % 或换行），拒绝交给 shell：'
        + JSON.stringify(String(a)).slice(0, 80);
    }
  }
  return null;
}

/** 这个可执行文件是不是 Windows 的批处理垫片（必须过 cmd.exe）。 */
export function needsCmdShim(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(bin));
}

/**
 * 起一个外部命令。
 *
 * @param {string} bin 可执行文件绝对路径（不接受裸命令名，避免 PATH 劫持）
 * @param {string[]} args
 * @param {{cwd?:string, timeout?:number, env?:object, maxBuffer?:number}} [opts]
 * @returns {{ok:boolean, out:string, code:number|null, err:string|null, via:'direct'|'cmd', unsafe?:string}}
 */
export function spawnTool(bin, args = [], opts = {}) {
  const base = {
    cwd: opts.cwd || process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
    timeout: opts.timeout ?? 120_000,
    env: { ...process.env, ...(opts.env || {}) },
    maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
  };

  let r;
  if (needsCmdShim(bin)) {
    const unsafe = unsafeArgsReason(args);
    if (unsafe) {
      // 不拼、不猜、不"转义一下试试" —— 直接让上层走配置文件那条路
      return { ok: false, out: '', code: null, err: unsafe, via: 'cmd', unsafe };
    }
    const line = buildWindowsCommandLine([bin, ...args]);
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    // `/s` + 外层再包一对引号：这是 cmd 的老规矩 —— 命令串以引号开头时，
    // cmd 会剥掉最外层那一对再执行。少了这层，`"C:\Program Files\...\t.cmd" a b`
    // 会被切得乱七八糟（实测：脚本根本没跑起来，参数全丢）。
    r = spawnSync(comspec, ['/d', '/s', '/c', `"${line}"`], {
      ...base,
      // 已经自己拼好了，别再让 Node 二次转义
      windowsVerbatimArguments: true,
    });
  } else {
    // 直接 exec：参数原样进 argv，不存在注入面
    r = spawnSync(bin, args, { ...base, shell: false });
  }

  return {
    ok: r.status === 0 && !r.error,
    out: `${r.stdout || ''}${r.stderr || ''}`.trim(),
    code: r.status,
    err: r.error ? r.error.message : null,
    via: needsCmdShim(bin) ? 'cmd' : 'direct',
  };
}

export default { spawnTool, quoteWindowsArg, buildWindowsCommandLine, unsafeArgsReason, needsCmdShim };
