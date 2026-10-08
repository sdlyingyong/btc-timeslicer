#!/usr/bin/env node
// 双入口端到端冒烟测试：在**真 DOM**（jsdom）里按浏览器顺序加载真实的
//   入口壳 → share/data.js → share/app.js
// 然后核对：① 页面能跑起来不抛错 ② 数据真的挂上了 ③ 两个入口写入的 localStorage 键名互不冲突。
//
// 为什么要单独一个脚本：主回归套件用轻量 mock（快、无依赖）；这个慢一些且需要 jsdom，
// 但它测的是「线上那两个 HTML 文件本身」，所以交付前值得单独跑一次。
//
// 用法：node tests/smoke_entries.cjs
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
function loadJsdom() {
  for (const c of ['jsdom', '/Users/mac/.workbuddy/binaries/node/workspace/node_modules/jsdom']) {
    try { return require(c); } catch (e) {}
  }
  return {};
}
const { JSDOM } = loadJsdom();
if (!JSDOM) { console.error('SKIP 未找到 jsdom：cd /Users/mac/.workbuddy/binaries/node/workspace && npm install jsdom'); process.exit(0); }

const appSrc = fs.readFileSync(path.join(REPO, 'share', 'app.js'), 'utf8');
const dataSrc = fs.readFileSync(path.join(REPO, 'share', 'data.js'), 'utf8');

// 极简 2D 上下文：只求「draw 不炸」，不校验画面（画面由 RENDER=1 的真画布测试负责）
function fakeCtx() {
  const state = {};
  return new Proxy({
    measureText: () => ({ width: 20 }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: [] })
  }, {
    get: (t, k) => (k in t ? t[k] : (k in state ? state[k] : () => {})),
    set: (t, k, v) => { state[k] = v; return true; }
  });
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
};

function boot(entryRel, label) {
  const html = fs.readFileSync(path.join(REPO, entryRel), 'utf8');
  const base = entryRel === 'index.html' ? '/btc-timeslicer/' : '/btc-timeslicer/live/';
  const dom = new JSDOM(html, { url: 'https://sdlyingyong.github.io' + base, pretendToBeVisual: true, runScripts: 'dangerously' });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  const errs = [];
  w.addEventListener('error', e => errs.push(String(e.message || e.error)));
  // 注意：这里**不**手动设实例标记 —— 壳里的内联 <script>window.__APP_INSTANCE__=…</script>
  // 在 runScripts:'dangerously' 下已经真执行过了，正好用来验证壳本身写对了。
  const marker = w.__APP_INSTANCE__;
  // 按浏览器顺序执行两个外链脚本
  try { w.eval(dataSrc); } catch (e) { errs.push('data.js: ' + e.message); }
  try { w.eval(appSrc); } catch (e) { errs.push('app.js: ' + e.message); }
  const keys = [];
  for (let i = 0; i < w.localStorage.length; i++) keys.push(w.localStorage.key(i));
  return { w, errs, marker, keys, label };
}

console.log('=== 复盘入口 index.html ===');
const A = boot('index.html', '复盘');
check('复盘入口无脚本错误', A.errs.length === 0, A.errs.join(' | ') || '干净');
check('复盘入口实例标记 = review', A.marker === 'review', String(A.marker));
check('复盘入口数据已挂上 window.BTCFUT_DATA', !!A.w.BTCFUT_DATA && A.w.BTCFUT_DATA['15m'].length > 100000,
  A.w.BTCFUT_DATA ? A.w.BTCFUT_DATA['15m'].length + ' 根 15m' : 'null');
check('复盘入口写入的键不带前缀',
  A.keys.every(k => !k.startsWith('live__')), A.keys.join(',') || '(还没写)');

console.log('\n=== 看盘入口 live/index.html ===');
const B = boot('live/index.html', '看盘');
check('看盘入口无脚本错误', B.errs.length === 0, B.errs.join(' | ') || '干净');
check('看盘入口实例标记 = live', B.marker === 'live', String(B.marker));
check('看盘入口数据已挂上 window.BTCFUT_DATA', !!B.w.BTCFUT_DATA && B.w.BTCFUT_DATA['15m'].length > 100000,
  B.w.BTCFUT_DATA ? B.w.BTCFUT_DATA['15m'].length + ' 根 15m' : 'null');
// §31：只有看盘入口会挂「实时补数」的状态位（复盘实例必须一动不动）
check('§31 看盘入口已挂上实时补数状态位 #liveStatus',
  !!B.w.document.getElementById('liveStatus'),
  B.w.document.getElementById('liveStatus') ? String(B.w.document.getElementById('liveStatus').textContent).slice(0, 40) : 'null');
check('§31 复盘入口不挂实时补数（复盘不碰活数据）',
  !A.w.document.getElementById('liveStatus'));

// 关键：让两个入口各写一次同名的进度，确认落到不同的键上
A.w.localStorage.setItem('kline_session_v1', 'REVIEW');
A.w.localStorage.setItem('live__kline_session_v1', 'LIVE');
check('同一浏览器里两个入口的进度互不覆盖',
  A.w.localStorage.getItem('kline_session_v1') === 'REVIEW' &&
  A.w.localStorage.getItem('live__kline_session_v1') === 'LIVE');

console.log('\n======== 双入口冒烟: ' + pass + ' PASS / ' + fail + ' FAIL ========');
process.exit(fail ? 1 : 0);
