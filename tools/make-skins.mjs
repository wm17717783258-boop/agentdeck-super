#!/usr/bin/env node
/**
 * 生成付费皮肤素材（sprite.svg + skin.json）。
 *
 * 为什么要脚本而不是手抄：一套 sprite 有 5 个状态、7 个渐变、1 个 filter、1 个 clipPath，
 * 手抄必然漏一处（最常见的是 clipPath id 重名，同一页面渲染两套就互相把对方裁掉）。
 * 这里所有 id 都带皮肤前缀，占位符固定为 {{size}} {{name}} {{state}} {{stateLabel}} {{accent}}。
 *
 * 用法：
 *   node tools/make-skins.mjs            # 生成下面 SKINS 里全部（已存在的跳过）
 *   node tools/make-skins.mjs --force    # 覆盖重写
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(HERE, '..', 'assets', 'skins');
const FORCE = process.argv.includes('--force');

/**
 * 每套皮肤只描述「不一样的」：配色 + 装饰 + 文案。
 * 结构（5 状态 / 渐变 / clipPath）由模板统一保证。
 */
const SKINS = [
  {
    id: 'premium-nebula',
    name: '星云',
    price: 28,
    accent: '#ff7ae0',
    desc: '会缓慢自转的星云环与尘埃带',
    palette: {
      bg: ['#120a24', '#26123f', '#3b1240'],
      veil: ['#ff7ae0', '#a67bff', '#5fd8ff'],
      body: ['#fff2fd', '#f4d8ff', '#cbb4ff'],
      aura: '#ff7ae0',
      ink: '#3a1c4d',
      stroke: '#c9a4ff',
      blush: '#ffb3ec',
    },
    decorate: `
    <g opacity="0.75">
      <ellipse cx="80" cy="92" rx="62" ry="20" fill="none" stroke="url(#P-veil)" stroke-width="1.6" stroke-dasharray="3 7" transform="rotate(-18 80 92)"/>
      <ellipse cx="80" cy="92" rx="48" ry="14" fill="none" stroke="url(#P-veil)" stroke-width="1.2" stroke-dasharray="2 9" transform="rotate(22 80 92)"/>
    </g>`,
  },
  {
    id: 'premium-jade',
    name: '青玉',
    price: 38,
    accent: '#5fe3b0',
    desc: '温润青玉与流动云纹，暗处会透一点光',
    palette: {
      bg: ['#07160f', '#0f2a20', '#123028'],
      veil: ['#5fe3b0', '#a8f0d2', '#ffe9a8'],
      body: ['#f6fffa', '#d6f5e6', '#a9d9c4'],
      aura: '#5fe3b0',
      ink: '#123326',
      stroke: '#7fc9a8',
      blush: '#ffd6a8',
    },
    decorate: `
    <g opacity="0.6" fill="none" stroke="url(#P-veil)" stroke-width="1.6" stroke-linecap="round">
      <path d="M22 118 q14 -12 30 -4 q16 8 28 -2"/>
      <path d="M96 126 q12 -10 26 -5 q12 5 20 -1"/>
      <path d="M30 44 q10 -10 22 -3"/>
    </g>`,
  },
  {
    id: 'premium-ember',
    name: '余烬',
    price: 48,
    accent: '#ffa552',
    desc: '暗红炉膛里的余烬与上浮火星',
    palette: {
      bg: ['#1a0806', '#2e100a', '#3d1a0a'],
      veil: ['#ffa552', '#ff6b3d', '#ffd98a'],
      body: ['#fff6ef', '#ffdcc2', '#e8a97f'],
      aura: '#ff7a3d',
      ink: '#3d1408',
      stroke: '#d98a5c',
      blush: '#ff9f6b',
    },
    decorate: `
    <g opacity="0.85">
      <circle cx="118" cy="118" r="3.4" fill="#ffd98a" opacity="0.9"/>
      <circle cx="130" cy="102" r="2" fill="#ff6b3d" opacity="0.75"/>
      <circle cx="104" cy="130" r="1.6" fill="#ffa552" opacity="0.6"/>
      <path d="M26 96 q6 -14 12 0 q-6 10 -12 0 z" fill="url(#P-veil)" opacity="0.5"/>
    </g>`,
  },
];

/** 把 #rrggbb 换成分量，用于给 border 混色（这里不需要，保持简单） */
function spriteFor(skin) {
  const P = skin.palette;
  const id = skin.id;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="{{size}}" height="{{size}}" viewBox="0 0 160 160" role="img" aria-label="{{name}}：{{stateLabel}}" data-skin="${id}" data-state="{{state}}">
  <title>{{name}} · {{stateLabel}}</title>
  <desc>AgentDeck 付费皮肤「${skin.name}」：${skin.desc}，当前状态 {{stateLabel}}</desc>
  <defs>
    <linearGradient id="${id}-bg" x1="0" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="${P.bg[0]}"/>
      <stop offset="0.45" stop-color="${P.bg[1]}"/>
      <stop offset="1" stop-color="${P.bg[2]}"/>
    </linearGradient>
    <linearGradient id="${id}-veil" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${P.veil[0]}" stop-opacity="0.75"/>
      <stop offset="0.5" stop-color="${P.veil[1]}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${P.veil[2]}" stop-opacity="0.65"/>
    </linearGradient>
    <linearGradient id="${id}-body" x1="0" y1="0" x2="0.3" y2="1">
      <stop offset="0" stop-color="${P.body[0]}"/>
      <stop offset="0.55" stop-color="${P.body[1]}"/>
      <stop offset="1" stop-color="${P.body[2]}"/>
    </linearGradient>
    <radialGradient id="${id}-aura" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${P.aura}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${P.aura}" stop-opacity="0"/>
    </radialGradient>
    <filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="3.2" result="b"/>
      <feMerge>
        <feMergeNode in="b"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    <clipPath id="${id}-frame">
      <rect x="3" y="3" width="154" height="154" rx="34"/>
    </clipPath>
  </defs>
  <style>
    .state { display: none; }
    [data-state="idle"] .s-idle,
    [data-state="working"] .s-working,
    [data-state="meeting"] .s-meeting,
    [data-state="visiting"] .s-visiting,
    [data-state="sleeping"] .s-sleeping { display: inline; }
    .eye-open { display: inline; }
    .eye-closed { display: none; }
    [data-state="sleeping"] .eye-open { display: none; }
    [data-state="sleeping"] .eye-closed { display: inline; }
    [data-state="sleeping"] .veil { opacity: 0.4; }
    .label { font: 600 12px/1 "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; fill: {{accent}}; letter-spacing: 0.14em; }
  </style>
  <g clip-path="url(#${id}-frame)">
    <rect x="0" y="0" width="160" height="160" fill="url(#${id}-bg)"/>
    <g class="veil" opacity="0.9">
      <path d="M-10 62 q44 -34 92 -12 q40 18 84 -6 v34 q-44 22 -86 4 q-46 -20 -90 8 z" fill="url(#${id}-veil)"/>
      <path d="M-8 24 q40 20 86 8 q44 -12 80 10 v16 q-40 -20 -82 -8 q-46 12 -84 -8 z" fill="url(#${id}-veil)" opacity="0.55"/>
    </g>
    <circle cx="80" cy="94" r="58" fill="url(#${id}-aura)"/>
    <g fill="#ffffff">
      <circle cx="30" cy="36" r="1.6" opacity="0.9"/>
      <circle cx="52" cy="22" r="1.1" opacity="0.65"/>
      <circle cx="132" cy="30" r="1.8" opacity="0.85"/>
      <circle cx="118" cy="16" r="1" opacity="0.5"/>
      <circle cx="146" cy="58" r="1.2" opacity="0.6"/>
      <circle cx="18" cy="86" r="1" opacity="0.45"/>
      <circle cx="140" cy="104" r="1.4" opacity="0.5"/>
    </g>${skin.decorate}
    <ellipse cx="80" cy="140" rx="42" ry="8" fill="{{accent}}" opacity="0.2"/>
    <path d="M54 48 q-10 -15 3 -21 q10 -4 13 11 z" fill="url(#${id}-body)" stroke="${P.stroke}" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M106 48 q10 -15 -3 -21 q-10 -4 -13 11 z" fill="url(#${id}-body)" stroke="${P.stroke}" stroke-width="2.2" stroke-linejoin="round"/>
    <ellipse cx="80" cy="108" rx="42" ry="33" fill="url(#${id}-body)" stroke="${P.stroke}" stroke-width="2.2"/>
    <circle cx="80" cy="71" r="33" fill="url(#${id}-body)" stroke="${P.stroke}" stroke-width="2.2"/>
    <g class="eye-open" filter="url(#${id}-glow)">
      <circle cx="69" cy="69" r="4.4" fill="${P.ink}"/>
      <circle cx="91" cy="69" r="4.4" fill="${P.ink}"/>
      <circle cx="70.6" cy="67.2" r="1.6" fill="{{accent}}"/>
      <circle cx="92.6" cy="67.2" r="1.6" fill="{{accent}}"/>
    </g>
    <g class="eye-closed">
      <path d="M64 69 q5 5 10 0" fill="none" stroke="${P.ink}" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M86 69 q5 5 10 0" fill="none" stroke="${P.ink}" stroke-width="2.4" stroke-linecap="round"/>
    </g>
    <circle cx="57" cy="80" r="7" fill="${P.blush}" opacity="0.35"/>
    <circle cx="103" cy="80" r="7" fill="${P.blush}" opacity="0.35"/>
    <path d="M76 82 q4 4 8 0" fill="none" stroke="${P.ink}" stroke-width="2" stroke-linecap="round" opacity="0.7"/>
    <path d="M58 112 q22 -12 44 0" fill="none" stroke="{{accent}}" stroke-width="2" opacity="0.55"/>
    <path d="M112 116 q22 -4 26 -24 q3 -16 -10 -20" fill="none" stroke="url(#${id}-veil)" stroke-width="6" stroke-linecap="round" opacity="0.85"/>
    <g class="state s-idle">
      <circle cx="125" cy="42" r="2.8" fill="{{accent}}" opacity="0.9"/>
      <circle cx="133" cy="56" r="1.8" fill="${P.veil[2]}" opacity="0.7"/>
      <circle cx="117" cy="30" r="1.4" fill="#ffffff" opacity="0.6"/>
      <path d="M26 58 q8 -10 16 0" fill="none" stroke="{{accent}}" stroke-width="1.8" stroke-linecap="round" opacity="0.5"/>
    </g>
    <g class="state s-working">
      <rect x="98" y="24" width="44" height="32" rx="7" fill="${P.bg[1]}" stroke="{{accent}}" stroke-width="1.6" opacity="0.95"/>
      <rect x="103" y="30" width="26" height="2.6" rx="1.3" fill="{{accent}}"/>
      <rect x="103" y="36" width="34" height="2.6" rx="1.3" fill="${P.veil[1]}"/>
      <rect x="103" y="42" width="18" height="2.6" rx="1.3" fill="{{accent}}" opacity="0.6"/>
      <rect x="103" y="48" width="28" height="2.6" rx="1.3" fill="#ffffff" opacity="0.45"/>
      <circle cx="34" cy="102" r="13" fill="none" stroke="${P.bg[2]}" stroke-width="3.6"/>
      <path d="M34 89 a13 13 0 0 1 13 13" fill="none" stroke="{{accent}}" stroke-width="3.6" stroke-linecap="round"/>
    </g>
    <g class="state s-meeting">
      <rect x="18" y="26" width="44" height="24" rx="9" fill="${P.bg[1]}" stroke="{{accent}}" stroke-width="1.8" opacity="0.95"/>
      <path d="M32 50 l0 8 l9 -8 z" fill="${P.bg[1]}" stroke="{{accent}}" stroke-width="1.8" stroke-linejoin="round"/>
      <circle cx="31" cy="38" r="2.2" fill="{{accent}}"/>
      <circle cx="40" cy="38" r="2.2" fill="{{accent}}"/>
      <circle cx="49" cy="38" r="2.2" fill="{{accent}}" opacity="0.6"/>
      <rect x="100" y="30" width="42" height="22" rx="9" fill="${P.bg[1]}" stroke="${P.veil[1]}" stroke-width="1.8" opacity="0.95"/>
      <path d="M124 52 l0 8 l-8 -8 z" fill="${P.bg[1]}" stroke="${P.veil[1]}" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M108 38 h26 M108 44 h14" stroke="${P.veil[1]}" stroke-width="2.2" stroke-linecap="round" opacity="0.8"/>
    </g>
    <g class="state s-visiting">
      <ellipse cx="126" cy="88" rx="11" ry="23" fill="none" stroke="{{accent}}" stroke-width="2" opacity="0.85"/>
      <ellipse cx="126" cy="88" rx="4" ry="14" fill="{{accent}}" opacity="0.3"/>
      <path d="M30 74 h26 v18 h-26 z" fill="none" stroke="{{accent}}" stroke-width="1.8" opacity="0.8"/>
      <path d="M30 75 l13 11 l13 -11" fill="none" stroke="{{accent}}" stroke-width="1.8" stroke-linejoin="round" opacity="0.8"/>
      <circle cx="46" cy="122" r="2.2" fill="${P.veil[2]}" opacity="0.8"/>
    </g>
    <g class="state s-sleeping">
      <path d="M110 26 a15 15 0 1 0 0 22 a12 12 0 0 1 0 -22 z" fill="{{accent}}" opacity="0.35"/>
      <text x="118" y="62" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="16" font-weight="700" fill="{{accent}}" opacity="0.8">z</text>
      <text x="130" y="52" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="11" font-weight="700" fill="{{accent}}" opacity="0.5">z</text>
    </g>
    <text class="label" x="80" y="152" text-anchor="middle">{{stateLabel}}</text>
  </g>
</svg>
`;
}

let made = 0;
let skipped = 0;
for (const skin of SKINS) {
  const dir = join(ASSETS, skin.id);
  const sprite = join(dir, 'sprite.svg');
  const manifest = join(dir, 'skin.json');
  if (!FORCE && existsSync(sprite) && existsSync(manifest)) {
    console.log(`跳过（已存在）: ${skin.id}`);
    skipped += 1;
    continue;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(sprite, spriteFor(skin), 'utf8');
  const meta = {
    schema: 1,
    id: skin.id,
    name: skin.name,
    price: skin.price,
    license: 'premium',
    sprite: 'sprite.svg',
    accent: skin.accent,
    author: 'AgentDeck 官方',
    version: '1.0.0',
    description: skin.desc,
  };
  writeFileSync(manifest, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  console.log(`生成: ${skin.id}（¥${skin.price}）`);
  made += 1;
}
console.log(`\n生成 ${made} 套，跳过 ${skipped} 套`);
