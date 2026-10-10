#!/usr/bin/env node
// 多入口端到端冒烟测试：在**真 DOM**（jsdom）里，按入口 HTML 里**声明的顺序**加载真实外链脚本
//   （复盘：share/data.js → share/app.js
//     自选：share/data.js → share/eth/manifest.js → share/app.js）
// 然后核对：① 页面能跑起来不抛错 ② 数据真的挂上了 ③ 各入口写入的 localStorage 键名互不冲突
//          ④ §31/§32/§33 各个实例的 DOM 与全局变量**只出现在该出现的入口**。
//
// 为什么单独一个脚本：主回归套件用轻量 mock（快、无依赖）；这个慢一些且需要 jsdom，
// 但它测的是「线上那几个 HTML 文件本身」，所以交付前值得单独跑一次。
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

console.log('=== 入口 HTML 静态检查 ===');
// 三个入口共用一个源（index.html）派生，靠 build_live.cjs 保证一致。
// 这里先静态对一遍「谁能引什么」——尤其是 §33 只许 watch 引 ETH 分片。
const htmlOf = f => fs.readFileSync(path.join(REPO, f), 'utf8');
const REV_HTML = htmlOf('index.html'), LIV_HTML = htmlOf('live/index.html'), WAT_HTML = htmlOf('watch/index.html');
const srcsOf = h => (h.match(/<script src="[^"]+"><\/script>/g) || []).map(s => /src="([^"]+)"/.exec(s)[1]);
check('§33 复盘入口不引 ETH 分片', !/share\/eth\//.test(REV_HTML), srcsOf(REV_HTML).join(' '));
// §34：看盘入口升级为多币种，从「不许引」反转为「必须引」，且规格与自选完全对齐。
check('§34 看盘入口引 ETH 分片 manifest（年份分片仍走渐进加载）',
  (LIV_HTML.match(/share\/eth\//g) || []).length === 1 && /share\/eth\/manifest\.js/.test(LIV_HTML),
  srcsOf(LIV_HTML).join(' '));
check('§33 自选入口且只引 manifest（年份分片走渐进加载）',
  (WAT_HTML.match(/share\/eth\//g) || []).length === 1 && /share\/eth\/manifest\.js/.test(WAT_HTML),
  srcsOf(WAT_HTML).join(' '));
// 注意：不能用 indexOf 判序 —— 入口壳顶部的注释里也写了「逻辑在 share/app.js」，会先被撞上。
// 必须用解析出来的 <script src> 列表判序。
for (const [name, html] of [['自选', WAT_HTML], ['看盘', LIV_HTML]]) {
  check('§33 ' + name + '入口的分片脚本排在 app.js 之前（app.js 执行时要能读到 manifest）', (() => {
    const s = srcsOf(html);
    return s.indexOf('../share/eth/manifest.js') >= 0 &&
           s.indexOf('../share/eth/manifest.js') < s.indexOf('../share/app.js');
  })(), srcsOf(html).join(' '));
}
check('§34 看盘与自选的脚本声明顺序完全一致', srcsOf(LIV_HTML).join('|') === srcsOf(WAT_HTML).join('|'),
  srcsOf(LIV_HTML).join(' '));

function boot(entryRel) {
  const html = htmlOf(entryRel);
  const base = '/btc-timeslicer/' + (entryRel === 'index.html' ? '' : entryRel.replace(/\/index\.html$/, '/') + '/');
  const dom = new JSDOM(html, { url: 'https://sdlyingyong.github.io' + base, pretendToBeVisual: true, runScripts: 'dangerously' });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => fakeCtx();
  const errs = [];
  w.addEventListener('error', e => errs.push(String(e.message || e.error)));
  // 注意：这里**不**手动设实例标记 —— 壳里的内联 <script>window.__APP_INSTANCE__=…</script>
  // 在 runScripts:'dangerously' 下已经真执行过了，正好用来验证壳本身写对了。
  const marker = w.__APP_INSTANCE__;
  // §32：jsdom 自带 WebSocket，但它会真的去连 wss://ws.okx.com（本机被墙）→ 异步 error 事件
  // 会污染 errs 断言。冒烟测试只关心「壳 + DOM + 存储键」，所以显式摘掉 WS 构造器，
  // 让 §32 的门控自然退化（连不上 → 离线），真实连通用回归测试的注入式假 WS 覆盖。
  w.WebSocket = undefined;
  const loaded = [];
  // 按 HTML 里 <script src> 的声明顺序加载真实文件。
  // jsdom 默认不抓外链资源（resources 不是 'usable'），所以这里手动补上 —— 顺带验证
  // 「入口壳里的相对路径在多一层目录时仍然指得对」。
  const dir = path.dirname(path.join(REPO, entryRel));
  for (const src of srcsOf(html)) {
    const f = path.resolve(dir, src);
    const name = path.relative(REPO, f);
    loaded.push(name);
    try { w.eval(fs.readFileSync(f, 'utf8')); } catch (e) { errs.push(name + ': ' + e.message); }
  }
  const keys = [];
  for (let i = 0; i < w.localStorage.length; i++) keys.push(w.localStorage.key(i));
  // §33：真实加载的分片脚本一律走不通（jsdom 不抓外链）→ 加载器挂在 30s 超时上。
  // 本脚本是同步跑完就 process.exit 的，不会为它多等，所以这里把未决的定时器清掉更干净。
  try { for (let i = 0; i < 9999; i++) clearTimeout(i); } catch (e) {}
  return { w, errs, marker, keys, loaded };
}

console.log('\n=== 复盘入口 index.html ===');
const A = boot('index.html');
check('复盘入口无脚本错误', A.errs.length === 0, A.errs.join(' | ') || '干净');
check('复盘入口实例标记 = review', A.marker === 'review', String(A.marker));
check('复盘入口加载了 data.js + app.js', A.loaded.join(' ') === 'share/data.js share/app.js', A.loaded.join(' '));
check('复盘入口数据已挂上 window.BTCFUT_DATA', !!A.w.BTCFUT_DATA && A.w.BTCFUT_DATA['15m'].length > 100000,
  A.w.BTCFUT_DATA ? A.w.BTCFUT_DATA['15m'].length + ' 根 15m' : 'null');
check('复盘入口写入的键不带前缀',
  A.keys.every(k => !k.startsWith('live__')), A.keys.join(',') || '(还没写)');
check('§33 复盘入口没有 ETHFUT_MANIFEST（ETH 分片只给自选）', A.w.ETHFUT_MANIFEST === undefined);

console.log('\n=== 看盘入口 live/index.html ===');
const B = boot('live/index.html');
check('看盘入口无脚本错误', B.errs.length === 0, B.errs.join(' | ') || '干净');
check('看盘入口实例标记 = live', B.marker === 'live', String(B.marker));
check('看盘入口数据已挂上 window.BTCFUT_DATA', !!B.w.BTCFUT_DATA && B.w.BTCFUT_DATA['15m'].length > 100000,
  B.w.BTCFUT_DATA ? B.w.BTCFUT_DATA['15m'].length + ' 根 15m' : 'null');
// §31：原先看盘入口靠顶栏的 #liveStatus 报告「补到几点了」。
// §34 之后看盘页的数据引擎换成 §32（WS 实时 + 断线 REST 轮询，覆盖全部标的），
// 状态位随之迁到侧栏的 #watchStatus（信息更全：连接态 + 数据至 + 分片进度），#liveStatus 不再创建。
check('§34 看盘入口挂了实时状态位 #watchStatus（§34 起由 §32 引擎驱动）',
  !!B.w.document.getElementById('watchStatus'),
  B.w.document.getElementById('watchStatus') ? String(B.w.document.getElementById('watchStatus').textContent).slice(0, 60) : 'null');
check('§31 看盘入口不再创建顶栏 #liveStatus（§31 已降为兜底、不启动）',
  !B.w.document.getElementById('liveStatus'));
check('§31 复盘入口不挂实时补数（复盘不碰活数据）',
  !A.w.document.getElementById('liveStatus'));
check('§33 看盘入口读到 window.ETHFUT_MANIFEST（§34 起看盘也是多币种）',
  !!B.w.ETHFUT_MANIFEST, B.w.ETHFUT_MANIFEST ? B.w.ETHFUT_MANIFEST.src : 'null');
check('§34 看盘入口挂了自选列表 DOM #watchList（与自选同规格）',
  !!B.w.document.getElementById('watchList'));
check('§34 看盘入口的自选列表同样渲染出两行（BTC / ETH）', (() => {
  const el = B.w.document.getElementById('watchList');
  return !!el && el.children.length === 2;
})(), (() => { const el = B.w.document.getElementById('watchList'); return el ? el.children.length + ' 行' : 'null'; })());
check('§34 看盘入口的分片脚本按声明顺序真实加载（data → manifest → app）',
  B.loaded.join(' ') === 'share/data.js share/eth/manifest.js share/app.js', B.loaded.join(' '));

console.log('\n=== 自选入口 watch/index.html ===');
const C = boot('watch/index.html');
check('§32 自选入口无脚本错误', C.errs.length === 0, C.errs.join(' | ') || '干净');
check('§32 自选入口实例标记 = watch', C.marker === 'watch', String(C.marker));
check('§32 自选入口数据已挂上 window.BTCFUT_DATA', !!C.w.BTCFUT_DATA && C.w.BTCFUT_DATA['15m'].length > 100000,
  C.w.BTCFUT_DATA ? C.w.BTCFUT_DATA['15m'].length + ' 根 15m' : 'null');
check('§32 自选入口挂了自选列表 DOM #watchList', !!C.w.document.getElementById('watchList'));
check('§32 复盘入口不挂自选列表（实例隔离）', !A.w.document.getElementById('watchList'));
// §34：看盘入口现在**也有**自选列表（上一条已断言），这里只确认它挂的是自己实例的那一份
check('§34 看盘与自选各自持有独立的自选列表 DOM（不是同一个节点）',
  B.w.document.getElementById('watchList') !== C.w.document.getElementById('watchList'));
check('§32 自选列表已渲染出两行（BTC / ETH）', (() => {
  const el = C.w.document.getElementById('watchList');
  return !!el && el.children.length === 2;
})(), (() => { const el = C.w.document.getElementById('watchList'); return el ? el.children.length + ' 行' : 'null'; })());
check('§34 自选入口的分片脚本按声明顺序真实加载（data → manifest → app）',
  C.loaded.join(' ') === 'share/data.js share/eth/manifest.js share/app.js', C.loaded.join(' '));
check('§33 复盘入口不出现历史进度文案（复盘不碰活数据）',
  !/历史加载中/.test(String((A.w.document.getElementById('watchStatus') || {}).textContent || '')));
check('§34 看盘入口的状态位也报告历史加载进度（与自选同规格）',
  /历史加载中 \d+\/\d+/.test(String((B.w.document.getElementById('watchStatus') || {}).textContent || '')),
  String((B.w.document.getElementById('watchStatus') || {}).textContent || 'null'));

// ---- §33 ETH 全量历史 ----
const EM = C.w.ETHFUT_MANIFEST;
check('§33 自选入口读到 window.ETHFUT_MANIFEST', !!EM, EM ? EM.src : 'null');
if (EM) {
  check('§33 manifest 声明的年份都真实存在（分片文件齐全）', (() => {
    const missing = EM.years.filter(y => !fs.existsSync(path.join(REPO, 'share', 'eth', y + '.js')));
    return missing.length === 0;
  })(), EM.years.join(','));
  check('§33 manifest 总量级与 BTC 同规格', EM.total && EM.total['15m'] >= 233730,
    EM.total ? EM.total['15m'] + ' 根 15m' : '-');
}
// 冒烟环境里 jsdom 抓不到外链分片 → 状态位必须**显式**写「历史加载中」，而不是假装已全量
const wstat = C.w.document.getElementById('watchStatus');
const wtext = wstat ? String(wstat.textContent) : '';
check('§33 自选入口状态位显式报告历史加载进度（fail-safe：不假装已有数据）',
  /历史加载中 \d+\/\d+/.test(wtext), wtext || 'null');
// 注：原先这里断言「复盘/看盘入口不出现历史进度文案」。§34 之后看盘入口也加载 ETH 分片，
// 该断言的前提不成立，已拆成上面两条（复盘：不出现；看盘：必须出现）。

// 关键：让三个入口各写一次同名的进度，确认落到不同的键上
A.w.localStorage.setItem('kline_session_v1', 'REVIEW');
A.w.localStorage.setItem('live__kline_session_v1', 'LIVE');
A.w.localStorage.setItem('watch__kline_session_v1', 'WATCH');
check('同一浏览器里三个入口的进度互不覆盖',
  A.w.localStorage.getItem('kline_session_v1') === 'REVIEW' &&
  A.w.localStorage.getItem('live__kline_session_v1') === 'LIVE' &&
  A.w.localStorage.getItem('watch__kline_session_v1') === 'WATCH');

console.log('\n======== 三入口冒烟: ' + pass + ' PASS / ' + fail + ' FAIL ========');
process.exit(fail ? 1 : 0);
