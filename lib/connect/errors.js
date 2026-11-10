/**
 * lib/connect/errors.js —— 写盘错误的「人话」目录。
 *
 * 为什么单独一个文件：用户看到的错误必须是**一份可枚举的清单**，不是每个调用点
 * 各写各的。以前同一个 ENOSPC 在三个地方分别被说成「写入失败」「EPERM」「未知错误」，
 * 用户没法形成稳定预期，也没法按文档排查。
 *
 * 约定：每个 reason 都是稳定字符串（CLI/脚本可以判断），message 说「哪坏了」，
 * hint 说「下一步做什么」。三者缺一不可 —— 只说坏了不说怎么办等于没报错。
 */

/** code → [reason, 发生了什么, 怎么办] */
export const WRITE_ERRORS = {
  EPERM: [
    'permission-denied',
    '文件或它所在的目录是只读 / 被占用',
    '换个有写权限的位置（--path），或先取消只读；也可以 nexi install --dry-run 拿到配置内容手工粘贴。',
  ],
  EACCES: [
    'permission-denied',
    '当前账号对这个文件没有写权限',
    '换到用户目录下的路径（--path），或以有权限的账号运行。原配置没有被改动。',
  ],
  EROFS: [
    'permission-denied',
    '这个位置是只读的（只读挂载 / 容器只读层 / 系统保护目录）',
    '换到可写目录：nexi install <host> --path <可写路径>。',
  ],
  ENOSPC: [
    'disk-full',
    '磁盘满了 —— 一个字节都写不进去',
    '先腾空间（清临时文件、回收站、旧备份），再重试。原配置完好，没有被写坏。',
  ],
  EDQUOT: [
    'disk-full',
    '磁盘配额用完了',
    '清理配额内的旧文件，或换到别的分区。原配置完好。',
  ],
  ENAMETOOLONG: [
    'path-too-long',
    '路径太长，超出了这个文件系统的上限',
    '把 --path 换短一点（放到用户目录下通常就够了）；Windows 上尤其注意 260 字符限制。',
  ],
  ENOENT: [
    'path-missing',
    '目标目录不存在，或路径中间有一段不存在',
    '确认 --path 指向的父目录已经建好：nexi install <host> --path <目录/文件>。',
  ],
  ENOTDIR: [
    'path-missing',
    '路径中间有一段是文件，不是目录',
    '检查 --path 里是不是把某个文件名当成了目录。',
  ],
  EBUSY: [
    'file-busy',
    '文件被别的程序占着（编辑器、同步盘、杀毒软件都可能占着）',
    '关掉占用它的程序再重试，或先 --dry-run 拿到内容手工粘贴。',
  ],
  EISDIR: [
    'path-is-dir',
    '--path 指向的是一个目录，不是配置文件',
    '补上文件名，例如 --path <目录>/mcp.json。',
  ],
};

/**
 * 把异常翻译成 {ok:false, reason, code, path, message, hint}。
 * 绝不返回堆栈，绝不抛 —— 调用方可以无条件把它当成最终结果往外传。
 */
export function translateWriteError(file, err, hint) {
  const code = String((err && err.code) || '');
  const hit = WRITE_ERRORS[code];
  const reason = hit ? hit[0] : 'write-failed';
  const what = hit ? hit[1] : ((err && err.message) || String(err || '未知错误'));
  const advice = hit ? hit[2] : '确认磁盘没满、路径没被占用；配置没有被改动，可以直接重试。';
  return {
    ok: false,
    reason,
    path: file,
    code,
    message: `${file} 写不进去（${code || '未知'}）：${what}。`,
    hint: hint || advice,
  };
}

/** 所有可能出现的 reason —— 让 CLI/文档/测试都能枚举，不用靠 grep 猜。 */
export function writeFailureReasons() {
  return [...new Set(Object.values(WRITE_ERRORS).map(([r]) => r)), 'write-failed'];
}
