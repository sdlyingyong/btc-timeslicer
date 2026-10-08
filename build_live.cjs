#!/usr/bin/env node
// 从「复盘」入口 index.html 生成「看盘」入口 live/index.html —— 单一源，避免两边代码漂移。
//
// 两者的差异只有 3 处（其余完全一致，连 CSS/画布代码都不复制）：
//   1) 实例标记   window.__APP_INSTANCE__ = 'review' → 'live'   （决定 localStorage/IndexedDB 前缀，两边进度互不干扰）
//   2) 资源路径   src="share/…" → src="../share/…"               （多一层目录）
//   3) 页面标题   BTC 时光机 · 复盘 → BTC 时光机 · 看盘
//
// 用法：node build_live.cjs          （正常流程，update_data.cjs 之后不必跑 —— 数据在 share/，与本文件无关）
//      node build_live.cjs --check  （只校验 live/index.html 是否与 index.html 同步，不写盘；测试用）
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = __dirname;
const SRC = path.join(REPO, 'index.html');
const OUT = path.join(REPO, 'live', 'index.html');

const DROPS = [
  ["window.__APP_INSTANCE__='review'", "window.__APP_INSTANCE__='live'"],
  ['<title>BTC 时光机 · 复盘</title>', '<title>BTC 时光机 · 看盘</title>'],
];

function buildLive(src) {
  let out = src;
  for (const [a, b] of DROPS) {
    if (out.indexOf(a) < 0) throw new Error('build_live: 源文件缺少可替换片段 ' + JSON.stringify(a));
    out = out.split(a).join(b);
  }
  // 资源路径：share/xxx → ../share/xxx（只动 src=" 后面那一段）
  out = out.replace(/(src=")share\//g, '$1../share/');
  if (!/src="\.\.\/share\/app\.js"/.test(out)) throw new Error('build_live: 资源路径替换失败');
  if (!/__APP_INSTANCE__='live'/.test(out)) throw new Error('build_live: 实例标记替换失败');
  return out;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const want = buildLive(fs.readFileSync(SRC, 'utf8'));
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
  if (checkOnly) {
    if (have === want) { console.log('[OK] live/index.html 与 index.html 同步'); process.exit(0); }
    console.error('[FAIL] live/index.html 与 index.html 不同步 —— 请跑 node build_live.cjs');
    process.exit(1);
  }
  if (have === want) { console.log('live/index.html 已是最新，无需改动'); return; }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, want);
  console.log('live/index.html 已生成（' + want.length + ' 字节）');
}

module.exports = { buildLive, SRC, OUT };

if (require.main === module) main();
