/**
 * 版本号读取：只从 package.json 拿，避免到处写死。
 * bin/nexi.mjs 和 lib/index.js 共用；出错返回 'dev'，不许因为读不到版本就崩。
 */
import { readFileSync } from 'node:fs';

export function readVersion() {
  try {
    const file = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    return String(pkg.version || 'dev');
  } catch {
    return 'dev';
  }
}

export default readVersion;
