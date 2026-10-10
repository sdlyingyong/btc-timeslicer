// btc-timeslicer 回归测试：覆盖全部画线/交互/盈亏比/视图功能
// 运行: node tests/regression.test.cjs
// 无外部依赖，mock canvas/DOM，直接驱动页面事件回调验证行为
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');
// §30 起 index.html 只是「入口壳」，代码与数据都抽走了：
//   逻辑 → share/app.js      数据 → share/data.js（两个入口共用这一份）
const APP_JS = path.join(__dirname, '..', 'share', 'app.js');
const DATA_JS = path.join(__dirname, '..', 'share', 'data.js');
let code = fs.readFileSync(APP_JS, 'utf8');
const DATA = JSON.parse(fs.readFileSync(DATA_JS, 'utf8').match(/window\.BTCFUT_DATA=(\{.*?\});/s)[1]);

let pass = 0, fail = 0;
const errors = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; errors.push(name + (extra ? ' [' + extra + ']' : '')); console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---------- mock 环境 ----------
let md = null, mm = null, ml = null, wmm = null, wkd = null, wmu = null, wl = null;
const ctxTexts = [];   // §20：记录所有 fillText 文本，供年度标签断言
const ctxRects = [];   // §21 诊断：记录所有 fillRect 参数
const ctxStrokes = []; // §25：记录每次 stroke() 的 {color, y}，用于校验通道上线绿/下线红的「颜色↔价位」对应
let ctxLastMoveY = null;
const ctxState = {};   // §25：mock 里被 set 的样式（如 strokeStyle），get 需能回读（hline 有 fillStyle = strokeStyle）
const ctx2d = new Proxy({
  measureText: () => ({ width: 40 }),
  createRadialGradient: () => ({ addColorStop() {} }),
  fillText: t => { ctxTexts.push(String(t)); },
  fillRect: (x, y, w, h) => { ctxRects.push([x, y, w, h]); },
  moveTo: (x, y) => { ctxLastMoveY = y; },
  stroke: () => { ctxStrokes.push({ color: String(ctxState.strokeStyle), y: ctxLastMoveY }); }
}, {
  get: (t, k) => (k in t ? t[k] : (k in ctxState ? ctxState[k] : (typeof k === 'string' ? (() => {}) : undefined))),
  set: (t, k, v) => { ctxState[k] = v; return true; }
});
const canvasMock = process.env.RENDER ? (() => {          // 真实渲染模式（额外导出 PNG 供肉眼复核）
  const { createCanvas } = require('@napi-rs/canvas');
  const c = createCanvas(1200, 700);
  const raw = c.getContext('2d');
  // 真实绘制的同时，把 fillRect / fillText 也记进 ctxRects / ctxTexts，
  // 这样 §20 年度标签、§21 成交量高度等断言在两种模式下都能跑（RENDER 只是多导一份 PNG）。
  c.getContext = () => new Proxy(raw, {
    get: (t, k) => {
      if (k === 'fillRect') return (x, y, w, h) => { ctxRects.push([x, y, w, h]); return t.fillRect(x, y, w, h); };
      if (k === 'fillText') return (s, x, y) => { ctxTexts.push(String(s)); return t.fillText(s, x, y); };
      if (k === 'moveTo') return (x, y) => { ctxLastMoveY = y; return t.moveTo(x, y); };
      if (k === 'stroke') return () => { ctxStrokes.push({ color: String(t.strokeStyle), y: ctxLastMoveY }); return t.stroke(); };
      const v = t[k];
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set: (t, k, v) => { t[k] = v; return true; }
  });
  c.clientWidth = 1200; c.clientHeight = 700;
  c.getBoundingClientRect = () => ({ width: 1200, height: 700, left: 0, top: 0 });
  c.style = {}; c.cursor = '';
  c.addEventListener = (type, cb) => {
    if (type === 'mousedown') md = cb;
    if (type === 'mousemove') mm = cb;
    if (type === 'mouseleave') ml = cb;
    if (type === 'wheel') wl = cb;
  };
  return c;
})() : {
  getContext: () => ctx2d,
  getBoundingClientRect: () => ({ width: 1200, height: 700, left: 0, top: 0 }),
  clientWidth: 1200, clientHeight: 700, width: 0, height: 0,
  style: {}, cursor: '',
  addEventListener(type, cb) {
    if (type === 'mousedown') md = cb;
    if (type === 'mousemove') mm = cb;
    if (type === 'mouseleave') ml = cb;
    if (type === 'wheel') wl = cb;
  }
};
const node = {
  textContent: '', className: '', disabled: false, value: '', style: {}, dataset: {}, checked: false,
  classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, removeEventListener() {},
  appendChild() {}, remove() {}, querySelectorAll: () => [], setAttribute() {}
};
const store = {};
const sandbox = {
  window: {
    BTCFUT_DATA: DATA, devicePixelRatio: 1,
    addEventListener(type, cb) {
      if (type === 'mousemove') wmm = cb;
      if (type === 'keydown') wkd = cb;
      if (type === 'mouseup') wmu = cb;
    }
  },
  document: {
    getElementById: () => node, querySelectorAll: () => [], querySelector: () => node,
    createElement: () => node, createTextNode: () => ({}), addEventListener() {}, body: {}
  },
  localStorage: {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  },
  indexedDB: undefined, URLSearchParams, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: f => f && f(), console, Promise, Date, Math, Number, JSON, Set, Map, Infinity,
  location: { protocol: 'http:' }, Blob: class {}, Worker: function () {}, canvas: canvasMock, devicePixelRatio: 1
};
sandbox.window.document = sandbox.document;
sandbox.window.__APP_INSTANCE__ = 'review';   // §30 主用例跑「复盘」实例（键名不加前缀，与历史断言一致）
sandbox.window.requestAnimationFrame = f => f && f();
global.requestAnimationFrame = sandbox.window.requestAnimationFrame;

code = code.replace("const canvas = document.getElementById('chart');", 'const canvas = canvasMock;');
const fn = new Function('window', 'document', 'localStorage', 'fetch', 'location', 'console', 'canvasMock', 'devicePixelRatio',
  code + `\n;window.__API__={
    getLines: () => lines, getTool: () => toolMode, getViewStart: () => viewStart, getViewCount: () => viewCount,
    getVolFrac: () => volFrac, getDrawingChannel: () => drawingChannel, getDrawingTrend: () => drawingTrend,
    getDrawingMeasure: () => drawingMeasure, getTradeMode: () => tradeMode, getRrDraft: () => rrDraft,
    getDragTarget: () => dragTarget, getDragStart: () => dragStart, getDrag: () => drag,
    getSelected: () => selectedLine, getContinuousDraw: () => continuousDraw, getScale: () => SCALE,
    getPanRubber: () => panRubber, getLastWheelAt: () => lastWheelAt,
    // §14 缩放降速 + VOL 平滑
    getZoomSensitivity: () => ZOOM_SENSITIVITY, getZoomMaxPerFrame: () => ZOOM_MAX_PER_FRAME,
    getVolNormSmooth: () => volNormSmooth, setVolNormSmooth: v => { volNormSmooth = v; },
    setTool: t => { toolMode = t; },
    setContinuousDraw: b => { continuousDraw = b; },
    setTradeMode: b => { tradeMode = b; },
    hitTest, dataXToScreenX, priceToY, xToIdx, yToPrice, closeAt, dataLen,
    getTradePlan, exitToolMode,
    findIdxSync, lnIdx, barTs, draw,
    clearLines: () => { lines = []; linesStore[lineKey()] = []; saveSessionNow(); },
    // §24 供应线/需求线
    getHLevelStyle: () => HLEVEL_STYLE, saveSessionNow,
    // §25 水平通道配色
    getHChannelStyle: () => HCHANNEL_STYLE,
    setView, getCur: () => cur, getRightTs: () => rightTs,
    setViewRange: (vs, vc) => { viewStart = vs; viewCount = vc; },
    parseDateInput,
    // §19 模拟交易
    getSimStore: () => simStore,
    simOpen, simAdd, simExit, simEvaluatePosition, simReplay, simAvgEntry, simOpenSize, simActiveStop, simLiqPrice, simRealizedPnl, simUnrealized, simDir, simMargin,
    loadSim, saveSim, simKey, simClearAll: () => { simStore = {}; saveSim(); },
    simDropMemory: () => { simStore = {}; },
    // §27 工具条排序
    szKey, szKids, szOrderOf, szApplyOrder, szDropTarget, szMoveTo, szSaveOrder, szResetSort,
    getSortKey: () => SORT_KEY,
    // §29 重叠对象命中：全部候选 + 同点轮换状态
    hitTestAll, getLastPick: () => lastPick, setLastPick: v => { lastPick = v; },
    // §31 看盘实例：直连 OKX 自动补数
    liveShouldRun, liveSetEnabled, liveSetFetch, liveUrl, liveParse, liveMerge, liveDeriveDaily,
    liveRefreshTick, liveRefreshStart, liveRefreshStop, liveGetStatus, liveIntervalMs, livePeriods,
    // §32 自选看盘 MVP：多币种 + WebSocket 实时
    watchShouldRun, watchSetEnabled, watchSetFetch, watchSetWS, watchInit,
    watchList, watchInstOf, watchRestUrl, watchWsArgs, watchOnWsMessage,
    watchPutSymbol, watchMergeInto, watchDeriveDaily,
    watchGetStatus, watchPolling, watchFallbackMs, watchConnect, watchDisconnect, watchOnOpen, watchOnClose,
    getSymbols: () => SYMBOLS, getWatchKey: () => WATCH_KEY,
    // §33 ETH 全量历史（按 UTC 自然年分片）
    ethShouldRun, ethSetEnabled, ethSetLoader, ethSetBase, ethManifest, ethBaseUrl,
    ethShardOf, ethRegisterExisting, ethLoadYear, ethLoadAll, ethReset, ethBootstrap,
    ethLoadedYears, ethFailedYears, ethPendingYears, ethProgress, ethProgressText, ethMaterialize,
    getEthKey: () => (typeof ETH_KEY === 'undefined' ? null : ETH_KEY),
    // §19.5 UI 控制器 + 渲染数据
    simMarks, simOpenAtCursor, simAddAtCursor, simExitAtCursor, simCursorTs, simCursorPrice, simLeverage, simStopVal, simSizeVal, drawSim, renderSim
  };`);
fn(sandbox.window, sandbox.document, sandbox.localStorage, async () => ({}), sandbox.location, console, canvasMock, 1);
const API = sandbox.window.__API__;

// ---------- 事件驱动工具 ----------
const W = 1200, H = 700;
const down = (x, y) => md({ clientX: x, clientY: y, button: 0 });
const move = (x, y) => mm({ clientX: x, clientY: y });
const wmove = (x, y) => wmm({ clientX: x, clientY: y });
const up = () => wmu({});
const key = (k) => wkd({ key: k, preventDefault() {} });
const keyShift = (k) => wkd({ key: k, shiftKey: true, preventDefault() {} });   // §26 Shift+↑/↓ 加速
const wheel = (dy, dx) => wl({ deltaY: dy || 0, deltaX: dx || 0, preventDefault() {} });
// §18：把视图平移顶到右边界（viewStart=len-vc，最新一根在屏幕最右、右边缘=len）。
// §18 放开 viewStart 下限后，平移可能停在历史/空白区，凡需「最新在屏」前提的断言都先 goLatest() 复位。
const goLatest = () => { for (let i = 0; i < 300; i++) wheel(0, 10000); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 屏幕坐标 <-> 逻辑坐标（依赖 SCALE 建立后）
const sx = idx => API.dataXToScreenX(idx);
const sy = p => API.priceToY(p);
const sxT = ts => API.dataXToScreenX(API.findIdxSync(ts));  // 时间戳 -> 屏幕X（线坐标现在以时间戳存储）

(async () => {
  await sleep(30); // 等待初始化 setView 完成

  // ============ 0. 环境 ============
  // 注：数据每日自动更新（update_data.cjs），不可硬编码根数/末根快照，否则每轮同步后必然 FAIL。
  // 改为「量级 + 周期比例 + 末根有效性」的持久性校验，仍能捕捉数据被清空/损坏。
  const L15 = DATA['15m'].length;
  check('数据加载：15m 根数量级（>24万）', L15 > 240000, '' + L15);
  check('数据加载：周期比例 15m:1h ≈ 4:1', Math.abs(L15 / DATA['1h'].length - 4) < 0.2,
    (L15 / DATA['1h'].length).toFixed(3));
  check('数据加载：周期比例 15m:1d ≈ 96:1', Math.abs(L15 / DATA['1d'].length - 96) < 5,
    (L15 / DATA['1d'].length).toFixed(2));
  check('SCALE 已建立', API.getScale().plotW > 0 && API.getScale().xW > 0, 'xW=' + API.getScale().xW.toFixed(3));
  check('默认周期 1d、工具 cursor', API.getTool() === 'cursor');

  // ============ 1. 水平线 ============
  {
    API.setTool('hline');
    down(400, 300);
    const h = API.getLines()[API.getLines().length - 1];
    check('hline 创建', !!h && h.type === 'hline' && near(h.price, API.yToPrice(300)));
    check('hline 自动退出工具', API.getTool() === 'cursor');
    // 命中 + 拖动
    const hit = API.hitTest(400, 300);
    check('hline 命中 body', !!hit && hit.handle === 'body');
    down(400, 300); move(400, 350);
    check('hline 拖动价格变化', near(h.price, API.yToPrice(350)));
    up(); move(-1, -1); // 结束拖拽
    check('hline 删除', deleteLine('hline', h));
  }

  // ============ 2. 趋势线 ============
  {
    API.setTool('trend');
    down(200, 500); move(300, 450); down(300, 450);
    const t = API.getLines()[API.getLines().length - 1];
    check('trend 两点创建', !!t && t.type === 'trend');
    check('trend 自动退出工具', API.getTool() === 'cursor');
    // 手柄命中
    const hp1 = API.hitTest(sxT(t.x1), sy(t.y1));
    check('trend p1 命中', !!hp1 && hp1.handle === 'p1');
    const hp2 = API.hitTest(sxT(t.x2), sy(t.y2));
    check('trend p2 命中', !!hp2 && hp2.handle === 'p2');
    // body 命中 + 整体平移（window mousemove）
    const midX = sxT((t.x1 + t.x2) / 2), midY = sy((t.y1 + t.y2) / 2);
    const hb = API.hitTest(midX, midY);
    check('trend body 命中', !!hb && hb.handle === 'body');
    const before = { y1: t.y1, y2: t.y2 };
    down(midX, midY); wmove(400, 500);
    check('trend body 整体平移', !near(t.y1, before.y1) && near(t.y1 - before.y1, t.y2 - before.y2, 1e-6));
    up(); move(-1, -1);
    // p1 手柄拖拽
    const bp1 = { x1: t.x1, y1: t.y1 };
    down(sxT(t.x1), sy(t.y1)); move(500, 300);
    check('trend p1 拖拽生效', t.x1 !== bp1.x1 || t.y1 !== bp1.y1);
    up(); move(-1, -1);
    check('trend 删除', deleteLine('trend', t));
  }

  // ============ 3. 测量线 ============
  {
    API.setTool('measure');
    down(200, 400); move(400, 300); down(400, 300);
    const m = API.getLines()[API.getLines().length - 1];
    check('measure 两点创建', !!m && m.type === 'measure');
    check('measure 自动退出', API.getTool() === 'cursor');
    const hp1 = API.hitTest(sxT(m.x1), sy(m.y1));
    check('measure p1 命中', !!hp1 && hp1.handle === 'p1');
    // 拖动 p2
    const bp2 = { x2: m.x2, y2: m.y2 };
    down(sxT(m.x2), sy(m.y2)); move(500, 500);
    check('measure p2 拖拽生效', m.x2 !== bp2.x2 || m.y2 !== bp2.y2);
    up(); move(-1, -1);
    // 绘制不崩（draw 已自动调用）
    check('measure 删除', deleteLine('measure', m));
  }

  // ============ 4. 价格通道（含回归 bug 验证） ============
  {
    API.setTool('channel');
    down(200, 500); // A
    down(400, 400); // B
    down(400, 300); // C
    const c = API.getLines()[API.getLines().length - 1];
    check('channel 三点创建', !!c && c.type === 'channel');
    check('channel 自动退出', API.getTool() === 'cursor');
    // 关键回归：存在 channel 时 hitTest 不得抛异常（此前 idxL/idxR 未定义导致所有拖拽失效）
    let threw = null;
    try {
      API.hitTest(300, 400); API.hitTest(sxT(c.x1), sy(c.y1)); API.hitTest(600, 300);
    } catch (e) { threw = e.message; }
    check('channel 存在时 hitTest 不抛异常（bug回归）', threw === null, threw || '');
    const hp1 = API.hitTest(sxT(c.x1), sy(c.y1));
    check('channel p1 命中', !!hp1 && hp1.handle === 'p1');
    const hp3 = API.hitTest(sxT(c.x3), sy(c.y3));
    check('channel p3 命中', !!hp3 && hp3.handle === 'p3');
    // p3 拖拽只改宽度（x3/y3）
    const bp3 = { x3: c.x3, y3: c.y3 };
    down(sxT(c.x3), sy(c.y3)); move(500, 250);
    check('channel p3 拖拽生效', c.x3 !== bp3.x3 || c.y3 !== bp3.y3);
    up(); move(-1, -1);
    // body 整体平移（三点同移，斜率不变）
    const bodyHit = API.hitTest(sxT((c.x1 + c.x2) / 2), sy((c.y1 + c.y2) / 2)) || API.hitTest(sxT(c.x2), sy(c.y2));
    check('channel body 命中', !!bodyHit && bodyHit.handle === 'body');
    if (bodyHit) {
      const bb = { y1: c.y1, y2: c.y2, y3: c.y3 };
      down(sxT((c.x1 + c.x2) / 2), sy((c.y1 + c.y2) / 2)); wmove(400, 500);
      check('channel body 整体平移（y3 同步）', !near(c.y1, bb.y1) &&
        near(c.y1 - bb.y1, c.y2 - bb.y2, 1e-6) && near(c.y1 - bb.y1, c.y3 - bb.y3, 1e-6));
      up(); move(-1, -1);
    }
    // 关键回归：channel 存在时空白拖拽视图平移必须正常（点击点选通道区域外的左侧空白；向左拖=看更早=viewStart 减小）
    const vs0 = API.getViewStart();
    down(100, 400); // 通道外空白处（通道射线起点 x≈200 左侧）
    move(150, 400); move(200, 400);
    up(); move(-1, -1);
    check('channel 存在时空白拖拽平移正常（bug回归）', API.getViewStart() !== vs0,
      'viewStart ' + vs0.toFixed(1) + ' -> ' + API.getViewStart().toFixed(1));
    check('channel 删除', deleteLine('channel', c));
    // 删除后拖拽仍正常
    const vs1 = API.getViewStart();
    down(100, 400); move(150, 400); up(); move(-1, -1);
    check('删除后视图拖拽正常', API.getViewStart() !== vs1);
  }

  // ============ 4b. 水平通道（两条水平线成区间带） ============
  {
    API.setTool('hchannel');
    down(300, 300);   // 第一条水平线
    down(300, 500);   // 第二条
    const hc = API.getLines()[API.getLines().length - 1];
    check('hchannel 两点创建', !!hc && hc.type === 'hchannel');
    check('hchannel 自动退出', API.getTool() === 'cursor');
    check('hchannel 价格=光标价', !!hc && near(hc.price1, API.yToPrice(300)) && near(hc.price2, API.yToPrice(500)),
      hc ? (hc.price1 + '/' + hc.price2) : 'null');
    // hitTest 不抛异常（承接 channel 同类回归）
    let threw = null;
    try { API.hitTest(400, 300); API.hitTest(400, 400); API.hitTest(400, 500); } catch (e) { threw = e.message; }
    check('hchannel 存在时 hitTest 不抛异常', threw === null, threw || '');
    const h1 = API.hitTest(400, API.priceToY(hc.price1));
    check('hchannel p1 命中', !!h1 && h1.handle === 'p1');
    const h2 = API.hitTest(400, API.priceToY(hc.price2));
    check('hchannel p2 命中', !!h2 && h2.handle === 'p2');
    // p1 拖拽只改 price1
    const bp1 = hc.price1;
    down(400, API.priceToY(hc.price1)); move(400, API.priceToY(hc.price1) - 30);
    check('hchannel p1 拖拽生效', !near(hc.price1, bp1));
    up(); move(-1, -1);
    // body 命中 + 整体平移（上下线同移，价差不变）
    const midY = (API.priceToY(hc.price1) + API.priceToY(hc.price2)) / 2;
    const bodyHit = API.hitTest(400, midY);
    check('hchannel body 命中', !!bodyHit && bodyHit.handle === 'body');
    if (bodyHit) {
      const b = { p1: hc.price1, p2: hc.price2 };
      down(400, midY); wmove(400, midY - 40);
      check('hchannel body 整体平移（价差不变）',
        !near(hc.price1, b.p1) && near(hc.price1 - b.p1, hc.price2 - b.p2, 1e-6),
        hc.price1 + '/' + hc.price2);
      up(); move(-1, -1);
    }
    check('hchannel 删除', deleteLine('hchannel', hc));
  }

  // ============ 5. 视图：空白拖拽平移 + 时间轴跳转 ============
  {
    const vs0 = API.getViewStart();
    down(100, 400); move(150, 400); up(); move(-1, -1);
    check('空白拖拽平移视图', API.getViewStart() !== vs0);
    // 时间轴点击（点左侧，目标视图在历史侧，不被右边缘 clamp）
    const vs1 = API.getViewStart();
    down(200, H - 20); // 底部时间轴左侧
    check('时间轴点击跳转视图', API.getViewStart() !== vs1);
  }

  // ============ 5.5 滚轮缩放（PRD §8：macOS 灵敏度优化） ============
  {
    const len = API.dataLen();

    // 方向：向上滚一格（deltaY<0）→ 放大（viewCount 减小）
    const vc0 = API.getViewCount();
    wheel(-120);
    const vc1 = API.getViewCount();
    check('滚轮向上=放大（viewCount 减小）', vc1 < vc0, vc0 + ' -> ' + vc1);
    // 方向：向下滚一格（deltaY>0）→ 缩小（viewCount 增大）
    wheel(120);
    const vc2 = API.getViewCount();
    check('滚轮向下=缩小（viewCount 增大）', vc2 > vc1, vc1 + ' -> ' + vc2);

    // §17 锚定不变量：单次缩放「右边缘保持」（在屏钉 len / 离屏锚当前右边缘，均不跳变）
    const edgeBefore17 = API.getViewStart() + API.getViewCount();
    wheel(-120);
    const edgeAfter17 = API.getViewStart() + API.getViewCount();
    check('§17 单次缩放右边缘保持（不跳变）', Math.abs(edgeAfter17 - edgeBefore17) <= 0.5,
      'edgeBefore=' + edgeBefore17.toFixed(1) + ' edgeAfter=' + edgeAfter17.toFixed(1));

    // 幅度参与换算：滚 2 格（-240）≈ 数学期望 viewCount × ZOOM_SENSITIVITY^-2（连续而非固定步进）
    // §14：ZOOM_SENSITIVITY 由 1.15 降为 1.08（缩放降速），期望值同步
    const vcS = API.getViewCount();
    wheel(-240);
    const vcT = API.getViewCount();
    const expect = Math.round(vcS * Math.pow(API.getZoomSensitivity(), -2));
    check('幅度参与换算（2格 ≈ ×底数^-2）', Math.abs(vcT - expect) <= 2, vcS + ' -> ' + vcT + ' (期望 ' + expect + ')');

    // §14 缩放降速：灵敏度应为 1.08（原 1.15），保证"慢点"生效
    check('§14 缩放灵敏度 = 1.08（降速生效）', Math.abs(API.getZoomSensitivity() - 1.08) < 1e-9,
      'ZOOM_SENSITIVITY=' + API.getZoomSensitivity());

    // §14 单帧钳制：单帧超量（10 格）应被钳到 ZOOM_MAX_PER_FRAME=3 格，超出部分丢弃
    {
      const vcA = API.getViewCount();
      wheel(-1200);   // = -10 格
      const vcB = API.getViewCount();
      const capRatio = Math.pow(API.getZoomSensitivity(), -API.getZoomMaxPerFrame());
      const gotRatio = vcB / vcA;
      check('§14 单帧缩放钳制（10格→3格）', Math.abs(gotRatio - capRatio) < 0.02,
        '实际 ×' + gotRatio.toFixed(4) + ' 期望 ×' + capRatio.toFixed(4));
    }

    // 小幅滚动：1/6 格（-20）也生效（连续缩放），且变化量明显小于整格
    const vcU = API.getViewCount();
    wheel(-20);
    const vcV = API.getViewCount();
    check('小幅滚动生效（连续缩放）', vcV < vcU, vcU + ' -> ' + vcV);
    check('小幅变化量 < 整格变化量', (vcU - vcV) < Math.round(vcU * 0.10),
      'delta ' + (vcU - vcV) + ' < ' + Math.round(vcU * 0.10));

    // 钳制：疯狂放大不越界（≥20）
    for (let i = 0; i < 60; i++) wheel(-5000);
    check('连续放大钳制 >= 20', API.getViewCount() >= 20, '' + API.getViewCount());
    // 钳制：疯狂缩小不越界（≤ len）
    for (let i = 0; i < 60; i++) wheel(5000);
    check('连续缩小钳制 <= len', API.getViewCount() <= len, API.getViewCount() + ' <= ' + len);
    // viewStart 始终在合法范围
    check('viewStart 不越界（§18 下限=1-vc）', API.getViewStart() >= 1 - API.getViewCount() && API.getViewStart() <= len - API.getViewCount(),
      'vs=' + API.getViewStart().toFixed(0) + ' vc=' + API.getViewCount());
  }

  // ============ 5.5b §17 缩放锚定（最新在屏→钉最新；最新离屏→锚当前右边缘） ============
  {
    const len = API.dataLen();

    // 场景1（最新在屏）：默认全量/最新贴右，任意缩放右边缘恒 = len（不露未来空白）
    goLatest();                                  // §18：先复位到最新在屏（避免继承离屏态）
    for (let i = 0; i < 10; i++) wheel(-5000);   // 放大到最小（最新在屏）
    check('§17 最新在屏·放大后右边缘=len', Math.abs((API.getViewStart() + API.getViewCount()) - len) <= 1e-6,
      'edge=' + (API.getViewStart() + API.getViewCount()));
    for (let i = 0; i < 10; i++) wheel(5000);    // 缩小
    check('§17 最新在屏·缩小后右边缘=len', Math.abs((API.getViewStart() + API.getViewCount()) - len) <= 1e-6,
      'edge=' + (API.getViewStart() + API.getViewCount()));

    // 场景2（最新离屏）：放大制造平移空间 → 平移到历史（最新离开屏幕）→ 缩放锚定当前右边缘（不拉回最新）
    for (let i = 0; i < 10; i++) wheel(-5000);   // 放大到最小（vc 小，留出平移空间）
    wheel(0, -10000);                            // 左滑到历史侧（最新离开屏幕）
    const curRight = API.getViewStart() + API.getViewCount();
    check('§17 离屏前置：最新已离开屏幕(curRight<len)', curRight < len,
      'curRight=' + curRight.toFixed(1) + ' len=' + len);
    const beforeEdge = API.getViewStart() + API.getViewCount();
    wheel(-120);                                // 在离屏历史位置放大
    const afterEdge = API.getViewStart() + API.getViewCount();
    check('§17 离屏·单次缩放右边缘保持(不拉回最新)',
      Math.abs(afterEdge - beforeEdge) <= 1e-6 && afterEdge < len,
      'before=' + beforeEdge.toFixed(1) + ' after=' + afterEdge.toFixed(1));
    check('§17 离屏·最新仍不在屏(afterEdge<len)', afterEdge < len, 'afterEdge=' + afterEdge.toFixed(1));

    // 场景3（极端缩小→全量）：先复位到最新在屏，缩到极限 = 全量（vc=len, vs=0, edge=len）
    goLatest();
    for (let i = 0; i < 60; i++) wheel(5000);
    check('§17 极端缩小=全量(viewCount=len)', Math.abs(API.getViewCount() - len) <= 1,
      'vc=' + API.getViewCount() + ' len=' + len);
    check('§17 全量时viewStart=0', API.getViewStart() === 0, 'vs=' + API.getViewStart());
    check('§17 全量时右边缘=len', Math.abs((API.getViewStart() + API.getViewCount()) - len) <= 1e-6,
      'edge=' + (API.getViewStart() + API.getViewCount()));

    // 场景4（不露未来）：任何状态下右边缘永不超出 len
    check('§17 右边缘永不超出len', (API.getViewStart() + API.getViewCount()) <= len + 1e-6,
      'edge=' + (API.getViewStart() + API.getViewCount()));
  }

  // ============ 5.5c §18 左侧留空：viewStart 下限放开，最早一根可到屏幕最右 ============
  {
    const len = API.dataLen();
    // 放大到较窄视图，制造平移空间
    for (let i = 0; i < 6; i++) wheel(-5000);
    const vc = API.getViewCount();
    // 持续左滑（看更早），应越过 0 进入负值，并停在 1-vc（最早一根在屏幕最右）
    for (let i = 0; i < 80; i++) wheel(0, -10000);
    const vs = API.getViewStart();
    check('§18 左滑越过0进入负值（左侧留空）', vs < 0, 'vs=' + vs.toFixed(2));
    check('§18 左滑下限=1-vc（最早根在屏幕最右）', Math.abs(vs - (1 - vc)) <= 1e-6,
      'vs=' + vs.toFixed(4) + ' 1-vc=' + (1 - vc));
    check('§18 右边缘=1（最早根在最右）', Math.abs((vs + vc) - 1) <= 1e-6, 'rightEdge=' + (vs + vc));
    // 显式触发一次负数窗口绘制，确认不抛异常（getBar 对负索引返回 null → 安全跳过）
    let drawOk = true;
    try { API.draw(); } catch (e) { drawOk = false; }
    check('§18 负数窗口 draw 不抛异常', drawOk);
    // 离屏态缩放后仍停在最左极值（右边缘保持=1，不回弹 0）
    wheel(-120);
    const vsA = API.getViewStart(), vcA = API.getViewCount();
    check('§18 离屏缩放后仍在最左极值（右边缘=1）', vsA < 0 && Math.abs((vsA + vcA) - 1) <= 1e-6,
      'vsA=' + vsA.toFixed(2) + ' edge=' + (vsA + vcA));
    // 复位：右滑回正常区间（viewStart 回到 >= 0 且不超过右极限）
    for (let i = 0; i < 120; i++) wheel(0, 10000);
    const vsR = API.getViewStart();
    check('§18 复位后 viewStart>=0', vsR >= 0, 'vs=' + vsR.toFixed(1));
    check('§18 右侧极限 rightEdge=len（行为不变）', Math.abs((vsR + API.getViewCount()) - len) <= 1e-6,
      'rightEdge=' + (vsR + API.getViewCount()) + ' len=' + len);
  }

  // ============ 5.6 双指滑动平移（PRD §9：deltaX 免按住拖拽，兼容 Win） ============
  {
    const len = API.dataLen();

    // 前置：恢复到可平移的中间视图（§5.5 末尾疯狂缩小把视图推到极限，viewStart 被钳死）
    for (let i = 0; i < 10; i++) wheel(-5000); // 连续放大到最小视图
    wheel(0, -10000);                          // 左滑把 viewStart 拉回中间（留出右移空间；v1.3 方向翻转）
    check('前置：视图可平移（viewStart 在中间且 viewCount < dataLen）',
      API.getViewStart() > 0 && API.getViewStart() < API.dataLen() - API.getViewCount() &&
      API.getViewCount() < API.dataLen(),
      'vs=' + API.getViewStart().toFixed(1) + ' vc=' + API.getViewCount() + ' len=' + API.dataLen());

    // 方向（v1.3 修正）：双指向左滑（deltaX<0，自然滚动）→ 看更早 → viewStart 减小
    const vs0 = API.getViewStart();
    wheel(0, -300); // 仅横向分量，纵向=0
    const vs1 = API.getViewStart();
    check('双指向左滑=看更早（viewStart 减小）', vs1 < vs0, vs0.toFixed(1) + ' -> ' + vs1.toFixed(1));

    // 方向：双指向右滑（deltaX>0）→ 看更近 → viewStart 增大
    wheel(0, 300);
    const vs2 = API.getViewStart();
    check('双指向右滑=看更近（viewStart 增大）', vs2 > vs1, vs1.toFixed(1) + ' -> ' + vs2.toFixed(1));

    // 换算与拖拽一致：ΔviewStart ≈ Δpx / xW（xW = plotW / viewCount；v1.3 方向翻转）
    const vcP = API.getViewCount();
    const xW = 1200 / vcP;
    const vsA = API.getViewStart();
    wheel(0, -120); // 向左 120px → 看更早 → viewStart 减小 120/xW
    const vsB = API.getViewStart();
    const expectPan = vsA - vsB;
    check('平移换算≈-Δpx/xW（120px 左滑 = 120/xW 减小）', Math.abs(expectPan - 120 / xW) <= 2,
      'actual ' + expectPan.toFixed(2) + ' expect ' + (120 / xW).toFixed(2));

    // 纵向分量不影响平移：deltaY 仍缩放、deltaX 平移互不干扰
    // （缩放右边缘锚定会重置 viewStart，故只断言缩放分量生效 + 状态合法）
    const vcBefore = API.getViewCount();
    const vsBefore = API.getViewStart();
    wheel(120, -120); // 纵向向下（缩小）+ 横向向左（看更近）
    const vcAfter = API.getViewCount();
    const vsAfter = API.getViewStart();
    check('双指斜滑：缩放分量生效（viewCount 增大）',
      vcAfter > vcBefore, 'vc ' + vcBefore + ' -> ' + vcAfter);
    check('双指斜滑后状态合法（viewStart 不越界）',
      vsAfter >= 0 && vsAfter <= len - vcAfter,
      'vs=' + vsAfter.toFixed(1) + ' vc=' + vcAfter);

    // 边界钳制：疯狂向左平移不越界（≥0）
    for (let i = 0; i < 200; i++) wheel(0, -10000);
    check('连续向左平移钳制至左极限 1-vc（§18）', Math.abs(API.getViewStart() - (1 - API.getViewCount())) <= 1e-6, '' + API.getViewStart().toFixed(1));
    // 疯狂向右平移不越界（≤ len - viewCount）
    for (let i = 0; i < 200; i++) wheel(0, 10000);
    check('连续向右平移钳制 <= len-vc', API.getViewStart() <= len - API.getViewCount(),
      API.getViewStart().toFixed(1) + ' <= ' + (len - API.getViewCount()));
    // 纯平移不改 viewCount
    const vcF = API.getViewCount();
    wheel(0, 120); wheel(0, -120);
    check('纯平移不改 viewCount', API.getViewCount() === vcF, vcF + ' -> ' + API.getViewCount());
  }

  // ============ 5.7 边界橡皮筋（PRD §10：到边后仍可拖一小段） ============
  {
    const len = API.dataLen();
    // 前置：先放大再左滑到左边界（viewStart=0）
    for (let i = 0; i < 10; i++) wheel(-5000);
    for (let i = 0; i < 50; i++) wheel(0, -10000);
    check('前置：已到左边界（viewStart=1-vc，§18）', Math.abs(API.getViewStart() - (1 - API.getViewCount())) <= 1e-6, '' + API.getViewStart());

    // 到边后继续左滑：viewStart 保持 0，panRubber 进入负值（橡皮筋）
    const rb0 = API.getPanRubber();
    wheel(0, -500); // 左边界继续左滑
    const rb1 = API.getPanRubber();
    check('左边界继续左滑→panRubber 负值（橡皮筋生效，vs=1-vc，§18）', rb1 < 0 && Math.abs(API.getViewStart() - (1 - API.getViewCount())) <= 1e-6,
      'rubber ' + rb0.toFixed(1) + ' -> ' + rb1.toFixed(1));
    check('橡皮筋限幅 <= 90px', Math.abs(rb1) <= 90, '' + Math.abs(rb1).toFixed(1));

    // 往回拖（右滑）先抵消橡皮筋，再移动 viewStart
    for (let i = 0; i < 5; i++) wheel(0, 500);
    check('往回拖抵消橡皮筋（panRubber 回 0 且 viewStart 增大）',
      API.getViewStart() > 0, 'vs=' + API.getViewStart().toFixed(1) + ' rubber=' + API.getPanRubber().toFixed(1));

    // 右边界对称：疯狂右滑到右边界，再继续右滑 → panRubber 正值
    for (let i = 0; i < 50; i++) wheel(0, 10000);
    const vsR = API.getViewStart();
    wheel(0, 500); // 右边界继续右滑
    check('右边界继续右滑→panRubber 正值', API.getPanRubber() > 0 && API.getViewStart() === vsR,
      'vs=' + API.getViewStart().toFixed(1) + ' rubber=' + API.getPanRubber().toFixed(1));

    // 恢复中间视图，避免污染后续测试
    for (let i = 0; i < 10; i++) wheel(-5000);
    wheel(0, -10000);
    check('恢复中间视图（viewStart 在中间）', API.getViewStart() > 0 && API.getViewStart() < len - API.getViewCount());
  }

  // ============ 5.8 周期切换锚定（PRD §11：固定最右侧 K 线时间） ============
  {
    const len1d = DATA['1d'].length;
    // 前置：1d 视图，放大到中间某处（非最新）
    for (let i = 0; i < 10; i++) wheel(-5000);   // 放大（viewCount 小，可看局部）
    wheel(0, -10000);                            // 左滑到历史中间某处
    const vsKeep = API.getViewStart();
    const vcKeep = API.getViewCount();
    check('前置：1d 视图非最新（可锚定）', vsKeep + vcKeep < len1d, 'vs=' + vsKeep.toFixed(1) + ' vc=' + vcKeep);

    // 切 1d → 4h：最右可见 K 线时间应锚定（viewCount 保持）
    const t1dRight = DATA['1d'][Math.max(0, Math.min(len1d - 1, Math.floor(vsKeep + vcKeep) - 1))][0];
    await API.setView(null, '4h');
    const vs4h = API.getViewStart(), vc4h = API.getViewCount();
    check('切 4h 后 viewCount 保持（不重置 260）', vc4h === vcKeep, vcKeep + ' -> ' + vc4h);
    const len4h = DATA['4h'].length;
    const t4hRight = DATA['4h'][Math.max(0, Math.min(len4h - 1, Math.floor(vs4h + vc4h) - 1))][0];
    // 4h K 线间隔 240 分钟，±1 根容差
    check('切 4h 最右时间 == 切前 1d 最右时间（±1根）', Math.abs(t4hRight - t1dRight) <= 240,
      t1dRight + ' -> ' + t4hRight + ' (Δ' + Math.abs(t4hRight - t1dRight) + 'min)');

    // 切回 1d：仍锚定原时间（右边缘时间不变）
    await API.setView(null, '1d');
    const vsBack = API.getViewStart(), vcBack = API.getViewCount();
    check('切回 1d viewCount 保持', vcBack === vcKeep, vcKeep + ' -> ' + vcBack);
    const t1dBack = DATA['1d'][Math.max(0, Math.min(len1d - 1, Math.floor(vsBack + vcBack) - 1))][0];
    check('切回 1d 最右时间不变（±1根）', Math.abs(t1dBack - t1dRight) <= 240,
      t1dRight + ' -> ' + t1dBack + ' (Δ' + Math.abs(t1dBack - t1dRight) + 'min)');
  }

  // ============ 5.9 缩放右边缘严格锚定（PRD §12：右侧价格贴框稳定） ============
  {
    // 场景1：单次缩放右边缘应保持稳定（偏差 ≤ 0.5 根）。
    // §17：在屏(含最新)锚定 len、离屏锚定当前右边缘——两种情形下单次缩放都不跳变。
    for (let i = 0; i < 10; i++) wheel(-5000); // 放大到最小
    wheel(0, -10000);                          // 左滑到中间（留出缩放空间，使最新离屏）
    const rightA = API.getViewStart() + API.getViewCount();
    wheel(-120); // 放大一格（viewCount 减小，右边缘应锚定不变）
    const rightB = API.getViewStart() + API.getViewCount();
    check('小缩放右边缘稳定（偏差≤0.5）', Math.abs(rightA - rightB) <= 0.5,
      'edgeBefore=' + rightA.toFixed(3) + ' edgeAfter=' + rightB.toFixed(3));

    // 场景2（核心）：从全量（viewCount=len，bkt>1）开始连续放大，
    // 右边缘必须恒锚定（当前实现桶对齐量化在奇数 viewStart 时破坏锚定）
    goLatest();                                // §18：先复位到最新在屏（避免继承离屏态）
    for (let i = 0; i < 30; i++) wheel(5000);  // 缩小到全量（viewCount=len）
    const anchor = API.dataLen();
    let ok = true, firstFail = '';
    for (let i = 0; i < 10; i++) {
      wheel(-120); // 连续放大（vc 从 len 递减，经过 bkt>1 区间）
      const edge = API.getViewStart() + API.getViewCount();
      if (Math.abs(edge - anchor) > 0.5) { ok = false; firstFail = 'edge=' + edge.toFixed(1) + ' @' + i; break; }
    }
    check('大缩放区间连续放大右边缘恒锚定（偏差≤0.5）', ok, firstFail || '10 次全锚定');

    // 边界钳制回归：缩放后状态合法
    check('缩放后状态合法', API.getViewStart() >= 1 - API.getViewCount() && API.getViewCount() >= 20 &&
      API.getViewStart() <= API.dataLen() - API.getViewCount());
  }

  // ============ 6. 成交量分隔条 ============
  {
    const vf0 = API.getVolFrac();
    // §13：hy = volTop - gap/2 = (PAD_T + H - PAD_T - PAD_B - volH - gap) + gap/2 = H - PAD_B - volH - gap/2
    // H=700, PAD_B=52, volFrac=0.22 → volH=154, gap=8 → hy ≈ 700 - 52 - 154 - 4 = 490
    down(600, 490); move(600, 430);
    check('volFrac 拖动调节', API.getVolFrac() !== vf0, vf0.toFixed(3) + ' -> ' + API.getVolFrac().toFixed(3));
    up(); move(-1, -1);
  }

  // ============ 6b. §14 VOL 归一化基准平滑（消除平移时整屏柱子跳变） ============
  {
    await API.setView(null, '1d');
    for (let i = 0; i < 6; i++) wheel(-120);   // 放大到适中窗口
    wheel(0, -3000);                            // 平移到历史某处
    API.draw();
    const base = API.getVolNormSmooth();
    check('§14 VOL 基准已建立', base > 0, 'volNormSmooth=' + base.toFixed(0));

    // 静止：连续 draw 不应漂移（已收敛到真实 vmax）
    const seq = [];
    for (let i = 0; i < 5; i++) { API.draw(); seq.push(API.getVolNormSmooth()); }
    check('§14 静止时 VOL 基准收敛（不漂移）', seq.every(v => Math.abs(v - base) <= base * 1e-3),
      seq.map(v => v.toFixed(0)).join(' → '));

    // 缓动生效性：把基准手动偏离 1.5x（< VMAX_SNAP_RATIO=3，走缓动分支而非吸附）。
    // 注意：mock 的 rAF 是同步的（f => f()），draw() 内 redrawSoon() 会递归跑完整段缓动，
    // 因此这里临时「挂起」rAF 以观察单帧步进比例，测完恢复并放行 pending 回调复位状态。
    {
      const realRaf = global.requestAnimationFrame;
      let pending = null;
      global.requestAnimationFrame = f => { pending = f; return 0; };
      try {
        const cur = API.getVolNormSmooth();
        const off = cur * 1.5;
        API.setVolNormSmooth(off);
        API.draw(); const a1 = API.getVolNormSmooth();
        const expect1 = off + (cur - off) * 0.18;   // 缓动一步 ≈ cur * 1.41
        check('§14 VOL 基准缓动（单帧走 18%，非瞬跳）',
          Math.abs(a1 - expect1) <= Math.max(1e-6, cur * 1e-3) && a1 < off && a1 > cur,
          'off=' + off.toFixed(0) + ' → ' + a1.toFixed(0) + ' (期望≈' + expect1.toFixed(0) + ') target=' + cur.toFixed(0));
        // 再挂起帧：继续靠近且步长递减
        API.draw(); const a2 = API.getVolNormSmooth();
        check('§14 VOL 基准缓动（逐帧靠近且步长递减）', a2 < a1 && a2 > cur && (a1 - a2) < (off - a1),
          a1.toFixed(0) + ' → ' + a2.toFixed(0));
      } finally {
        global.requestAnimationFrame = realRaf;
        if (pending) pending();   // 复位 drawScheduled
      }
    }

    // 缓动收敛：持续 draw 直到稳定，最终应回到真实窗口 vmax
    let prev = API.getVolNormSmooth(), stable = 0;
    for (let i = 0; i < 80 && stable < 3; i++) {
      API.draw();
      const now = API.getVolNormSmooth();
      if (Math.abs(now - prev) <= Math.max(1e-6, now * 1e-3)) stable++; else stable = 0;
      prev = now;
    }
    check('§14 VOL 基准最终收敛', stable >= 3, 'final=' + prev.toFixed(0));

    // 切换周期应「直接吸附」：1d（百万级）→ 15m（千级）量纲差 >> 3x，
    // 第一帧就该到位，不出现跨量纲长时间爬升
    await API.setView(null, '15m');
    API.draw(); const sw1 = API.getVolNormSmooth();
    API.draw(); const sw2 = API.getVolNormSmooth();
    check('§14 切换周期直接吸附（不缓动爬升）',
      Math.abs(sw1 - sw2) <= Math.max(1e-6, sw1 * 1e-3),
      '15m 首帧=' + sw1.toFixed(0) + ' 次帧=' + sw2.toFixed(0));
  }

  // ============ 7. 盈亏比 ============
  {
    API.setTradeMode(true);
    goLatest();                                // §18：复位到最新在屏，确保 down(600,400) 命中有效K线（否则落空白区→entry 空→trade 不生成）
    // 视图最右（最新K线）按下定入场
    down(600, 400);
    check('rrDraft 创建（入场=K线收盘）', !!API.getRrDraft() && API.getRrDraft().phase === 'tp' && API.getRrDraft().entry != null);
    move(600, 350); up(); // 定 TP
    check('rrDraft 进入 SL 阶段', !!API.getRrDraft() && API.getRrDraft().phase === 'sl' && API.getRrDraft().tp != null);
    move(600, 450); up(); // 定 SL
    const tr = API.getLines().find(l => l.type === 'trade');
    check('trade plan 生成', !!tr && tr.entry != null && tr.tp != null && tr.sl != null);
    API.setTradeMode(false);
    // trade 三线命中
    const hTp = API.hitTest(700, API.priceToY(tr.tp));
    check('trade TP 线命中', !!hTp && hTp.handle === 'tp');
    const hSl = API.hitTest(700, API.priceToY(tr.sl));
    check('trade SL 线命中', !!hSl && hSl.handle === 'sl');
    check('trade 删除', deleteLine('trade', tr));
  }

  // ============ 8. 连画模式（hline 原逻辑即强制退出，连画仅对多点工具生效） ============
  {
    API.setContinuousDraw(true);
    API.setTool('trend');
    down(200, 400); down(400, 300);
    check('连画模式 trend 画完不退出工具', API.getTool() === 'trend');
    down(300, 350); down(500, 250);
    check('连画模式可连续绘制', API.getTool() === 'trend');
    API.setContinuousDraw(false);
    down(200, 300); down(400, 200);
    check('非连画模式画完退出', API.getTool() === 'cursor');
  }

  // ============ 9. 键盘删除 ============
  {
    API.setTool('trend');
    down(200, 400); down(400, 300);
    const t = API.getLines()[API.getLines().length - 1];
    check('trend 创建（键盘删除前置）', !!t);
    API.hitTest(sxT(t.x1), sy(t.y1));
    // 模拟点击选中
    down(sxT(t.x1), sy(t.y1));
    key('Delete');
    check('Del 删除选中对象', !API.getLines().includes(t));
    up(); move(-1, -1);
  }

  // ============ 10. 数据完整性 ============
  {
    let ok15 = true, gap = -1;
    for (let i = 1; i < DATA['15m'].length; i++) {
      if (DATA['15m'][i][0] - DATA['15m'][i - 1][0] !== 15) { ok15 = false; gap = i; break; }
    }
    check('15m 时间连续', ok15, gap >= 0 ? 'gap@' + gap : '');
    for (const p of ['15m', '1h', '4h', '1d']) {
      let mono = true;
      for (let i = 1; i < DATA[p].length; i++) if (DATA[p][i][0] <= DATA[p][i - 1][0]) { mono = false; break; }
      check(p + ' 时间戳递增', mono);
    }
    // 末根：15 分钟对齐 + 落在合理时间窗（数据起点 2019-09-08 ~ 现在+1天），不硬编码快照
    const lastT = DATA['15m'][DATA['15m'].length - 1][0];
    check('15m 末根 15 分钟对齐', lastT % 15 === 0, 'ts=' + lastT);
    check('15m 末根时间落在合理区间',
      lastT * 60000 > Date.UTC(2019, 8, 8) && lastT * 60000 <= Date.now() + 86400000,
      new Date(lastT * 60000).toISOString());
  }

  // ============ 11. 持久化 ============
  {
    API.setTool('channel');
    down(200, 500); down(400, 400); down(400, 300);
    await sleep(700); // 等待 scheduleSessionSave 防抖写入
    const saved = store['kline_session_v1'];
    check('画线写入 localStorage', !!saved && saved.includes('channel'));
    check('清除画线', clearLines());
    check('重置刷新', resetSession());
  }

  // ============ 12. 日期跳转解析 ============
  {
    const pd = API.parseDateInput;
    const D = (y, m, d) => Date.UTC(y, m - 1, d);
    check('23-7-17 → 2023-07-17',    pd('23-7-17')   === D(2023,7,17));
    check('2023-7-17 → 2023-07-17',  pd('2023-7-17') === D(2023,7,17));
    check('230717 → 2023-07-17',      pd('230717')    === D(2023,7,17));
    check('20230717 → 2023-07-17',    pd('20230717')  === D(2023,7,17));
    check('7-17 → 今年7-17',          pd('7-17')      === D(2026,7,17));
    check('2025/03/13 → 2025-03-13', pd('2025/03/13') === D(2025,3,13));
    check('ISO 2024-01-01',           pd('2024-01-01') === D(2024,1,1));
    check('无效输入返回 null',        pd('xyz')        === null);
    check('无效月份返回 null',        pd('2023-13-01') === null);
    check('空串返回 null',            pd('')            === null);
  }

  // ============ 13. 画线跨周期显示（时间戳锚定） ============
  {
    API.setTool('trend');
    down(300, 500); down(500, 400);
    const t = API.getLines()[API.getLines().length - 1];
    check('日线创建趋势线', !!t);
    const ts1 = t.x1;
    // 切到 15m：线随标的共享（lineKey=symbol），时间戳可在 15m 定位
    await API.setView(null, '15m');
    check('切换15m后线仍在', API.getLines().includes(t));
    const i15 = API.lnIdx(t, 'x1');
    check('15m 中能定位到该线时间戳', i15 >= 0 && i15 < API.dataLen());
    // 切回日线仍可见，且时间戳未变（锚定同一根）
    await API.setView(null, '1d');
    check('切回日线线仍在', API.getLines().includes(t));
    check('时间戳锚定未变', t.x1 === ts1);
    // 清理
    API.setTool('cursor');
    check('清理跨周期测试线', (API.clearLines(), API.getLines().length === 0));
  }

  // ============ 19. §19 模拟交易（测试先行） ============
  {
    API.simClearAll();
    // E1：光标处开多，size=1 lev=10x sl=设
    const openTs = 1700000000; // 仅测试用的时间戳，不依赖真实数据
    const pL = API.simOpen({ sym: 'BTC', period: '1d', side: 'long', leverage: 10, size: 1, stop: 100, ts: openTs, price: 1000 });
    check('§19 E1 开多生成 open 持仓', !!pL && pL.status === 'open' && pL.side === 'long');
    check('§19 E1 avgEntry = 光标价', near(API.simAvgEntry(pL), 1000));
    check('§19 E1 activeStop = sl', near(API.simActiveStop(pL), 100));
    check('§19 E1 leverage = 10', pL.leverage === 10);
    check('§19 E1 openTs = 光标', pL.openTs === openTs);
    const saved1 = JSON.parse(store['kline_sim_v1'] || '{}');
    check('§19 E1 日志含"开多"', !!saved1['BTC|1d'] && saved1['BTC|1d'].log.some(l => l.msg.includes('开多')));

    // E1 开空：stop 取较大值（空头止损在上方）
    const pS = API.simOpen({ sym: 'BTC', period: '1d', side: 'short', leverage: 10, size: 1, stop: 1100, ts: openTs + 1, price: 1000 });
    check('§19 E1 开空 side=short', pS.side === 'short');
    check('§19 E1 空 activeStop = max(1100)', near(API.simActiveStop(pS), 1100));

    // E5：杠杆 5x vs 10x 同价同 size → ROI 比例 2x、强平价 10x 更近
    const p5 = API.simOpen({ sym: 'ETH', period: '1d', side: 'long', leverage: 5, size: 1, stop: null, ts: openTs + 2, price: 1000 });
    const p10 = API.simOpen({ sym: 'ETH', period: '1d', side: 'long', leverage: 10, size: 1, stop: null, ts: openTs + 3, price: 1000 });
    const liq5 = API.simLiqPrice(p5), liq10 = API.simLiqPrice(p10);
    check('§19 E5 强平价 10x 更近(entry)', Math.abs(liq10 - 1000) < Math.abs(liq5 - 1000), 'liq10=' + liq10 + ' liq5=' + liq5);
    check('§19 E5 强平价距离比 = 0.5', near(Math.abs(liq10 - 1000) / Math.abs(liq5 - 1000), 0.5));
    const roi5 = API.simUnrealized(p5, 1100) / API.simMargin(p5);
    const roi10 = API.simUnrealized(p10, 1100) / API.simMargin(p10);
    check('§19 E5 ROI(10x) 是 ROI(5x) 的 2 倍', near(roi10 / roi5, 2), 'roi5=' + roi5 + ' roi10=' + roi10);
    API.simClearAll();
  }

  // ============ 19.2 加仓（E3） ============
  {
    API.simClearAll();
    const t0 = 1700000000;
    const base = API.simOpen({ sym: 'BTC', period: '1d', side: 'long', leverage: 10, size: 1, stop: 900, ts: t0, price: 1000 });
    check('§19 E3 开仓后 legs=1', base.legs.length === 1);
    const added = API.simAdd({ sym: 'BTC', period: '1d', size: 1, stop: 950, ts: t0 + 1, price: 1100 });
    check('§19 E3 加仓后 legs=2', added.legs.length === 2);
    check('§19 E3 openSize 增加=2', near(API.simOpenSize(added), 2), '' + API.simOpenSize(added));
    check('§19 E3 avgEntry 重算=1050', near(API.simAvgEntry(added), 1050));
    check('§19 E3 新腿独立 stop=950', added.legs[1].stop === 950);
    check('§19 E3 activeStop=min(900,950)=900', near(API.simActiveStop(added), 900));
    const saved = JSON.parse(store['kline_sim_v1'] || '{}');
    check('§19 E3 日志含"加仓"', saved['BTC|1d'].log.some(l => l.msg.includes('加仓')));
    API.simClearAll();
  }

  // ============ 19.3 平仓：平半 / 平全（E4） ============
  {
    API.simClearAll();
    const t0 = 1700000000;
    const pos = API.simOpen({ sym: 'BTC', period: '1d', side: 'long', leverage: 10, size: 2, stop: null, ts: t0, price: 1000 });
    // 盈利到 1100 平半
    const half = API.simExit({ sym: 'BTC', period: '1d', kind: 'half', ts: t0 + 1, price: 1100 });
    check('§19 E4 平半生成 exit(kind=half)', half.exits.some(x => x.kind === 'half'));
    check('§19 E4 平半 size=1（openSize 减半）', near(API.simOpenSize(half), 1), '' + API.simOpenSize(half));
    check('§19 E4 平半 realized = dir*(1100-1000)*1 = 100', near(API.simRealizedPnl(half), 100), '' + API.simRealizedPnl(half));
    check('§19 E4 平半后 status 仍 open', half.status === 'open');
    // 再平全（价格 1200）
    const full = API.simExit({ sym: 'BTC', period: '1d', kind: 'full', ts: t0 + 2, price: 1200 });
    check('§19 E4 平全 realized 累加 = 300', near(API.simRealizedPnl(full), 300), '' + API.simRealizedPnl(full));
    check('§19 E4 平全后 status=closed', full.status === 'closed');
    // 单次全平
    API.simClearAll();
    const p2 = API.simOpen({ sym: 'BTC', period: '1d', side: 'short', leverage: 5, size: 1, stop: null, ts: t0, price: 1000 });
    const f2 = API.simExit({ sym: 'BTC', period: '1d', kind: 'full', ts: t0 + 1, price: 900 }); // 空头盈利
    check('§19 E4 空头全平 realized = dir*(900-1000)*1 = 100', near(API.simRealizedPnl(f2), 100), '' + API.simRealizedPnl(f2));
    check('§19 E4 空头全平 closed', f2.status === 'closed');
    API.simClearAll();
  }

  // ============ 19.4 回放估值：止损/强平按光标触发（E2/E6/E9） ============
  {
    // E2：光标右移越过 sl 价 → 自动生成"损"退出
    API.simClearAll();
    const pSL = API.simOpen({ sym: 'BTC', period: '1d', side: 'long', leverage: 10, size: 1, stop: 900, ts: 100, price: 1000 });
    const exSL = API.simEvaluatePosition(pSL, [[200, 1010, 1020, 895, 900, 10]]); // 低 895 <= 900
    check('§19 E2 触发止损 kind=sl', !!exSL && exSL.kind === 'sl' && exSL.price === 900);
    check('§19 E2 触发后 status=closed', pSL.status === 'closed');
    check('§19 E2 realized=dir*(900-1000)*1=-100', near(API.simRealizedPnl(pSL), -100), '' + API.simRealizedPnl(pSL));

    // E9：强平价被刺穿（无止损）→ kind=liq，价=liq
    API.simClearAll();
    const pLIQ = API.simOpen({ sym: 'BTC', period: '1d', side: 'long', leverage: 10, size: 1, stop: null, ts: 100, price: 1000 });
    // liq = 1000*(1-0.1)=900；bar 低 898 <= 900 → 强平
    const exLIQ = API.simEvaluatePosition(pLIQ, [[200, 1010, 1020, 898, 905, 10]]);
    check('§19 E9 触发强平 kind=liq', !!exLIQ && exLIQ.kind === 'liq' && near(exLIQ.price, 900));
    check('§19 E9 强平后 status=closed', pLIQ.status === 'closed');

    // E6：光标左移回到开仓前 → 持仓未触发（不显示）；右移再出现（可逆）。用真实数据 ts 保证窗口有 bar。
    API.simClearAll();
    const D1 = DATA['1d']; const iR = D1.length - 5;
    const openTsR = D1[iR][0], entryR = D1[iR][4];
    const pRev = API.simOpen({ sym: 'BTC', period: '1d', side: 'long', leverage: 10, size: 1, stop: 1, ts: openTsR, price: entryR }); // stop 极低，常规右移不触发
    API.simReplay('BTC', '1d', openTsR - 1); // 光标 < openTs
    check('§19 E6 光标<openTs：无自动退出', pRev.exits.filter(e => e.auto).length === 0);
    check('§19 E6 光标<openTs：status open（面板隐藏）', pRev.status === 'open');
    // 右移一格（下一根），无穿越 → 仍 open（可见）
    API.simReplay('BTC', '1d', D1[iR + 1][0]);
    check('§19 E6 右移无穿越：仍 open（可见）', pRev.status === 'open' && pRev.exits.filter(e => e.auto).length === 0);
    // 把止损改到刚高于下一根 low → 右移触发 sl（等价 UI 改止损）
    pRev.legs[0].stop = D1[iR + 1][3] + 0.5;
    API.simReplay('BTC', '1d', D1[iR + 1][0]);
    check('§19 E6 右移触发 auto sl', pRev.exits.some(e => e.auto && e.kind === 'sl'));
    check('§19 E6 右移后 status=closed', pRev.status === 'closed');
    // 再左移 → 自动退出被剥离（可逆）
    API.simReplay('BTC', '1d', openTsR - 1);
    check('§19 E6 左移回：自动退出被剥离（可逆）', pRev.exits.filter(e => e.auto).length === 0);
    check('§19 E6 左移回：status open（隐藏）', pRev.status === 'open');

    // E2 集成：用真实 1d 数据窗口切片（变量加后缀避免与上方 E6 块同作用域重名）
    API.simClearAll();
    const D1b = DATA['1d']; const i = D1b.length - 5;
    const openTsB = D1b[i][0], entryB = D1b[i][4];
    const nextLowB = D1b[i + 1][3]; const stopB = nextLowB + 0.5; const cursorB = D1b[i + 1][0];
    const pR = API.simOpen({ sym: 'BTC', period: '1d', side: 'long', leverage: 10, size: 1, stop: stopB, ts: openTsB, price: entryB });
    API.simReplay('BTC', '1d', cursorB);
    check('§19 E2 集成：真实数据窗口触发 sl', pR.status === 'closed' && pR.exits.some(e => e.auto && e.kind === 'sl'));
    check('§19 E2 集成：退出价=stopB', pR.exits.some(e => e.auto && near(e.price, stopB)), 'stopB=' + stopB);
    API.simClearAll();
  }

  // ============ 19.5 UI 控制器 + 渲染数据（E1/E3/E4 接线、E10 标注/面板） ============
  {
    // 控制器以 opts 显式覆盖光标，保证无 DOM 可测；E1 开多/开空接线
    API.simClearAll();
    const pO = API.simOpenAtCursor('long', { sym: 'BTC', period: '1d', price: 1000, ts: 100, leverage: 10, size: 1, stop: 900 });
    check('§19 E1 控制器开多：生成未平持仓', !!pO && pO.status === 'open' && pO.side === 'long');
    check('§19 E5 控制器默认 10x（无 select）', pO.leverage === 10);
    const st5 = API.getSimStore()['BTC|1d'];
    check('§19 E1 控制器开多：写入 simStore', st5 && st5.positions.length === 1);
    // simMarks（E10 渲染数据）：入场点/均价/SL/强平
    const mk = API.simMarks('BTC', '1d', 100);
    check('§19 E10 simMarks 数量=1', mk.length === 1);
    check('§19 E10 入场均价=1000', near(mk[0].entryPrice, 1000), '' + mk[0].entryPrice);
    check('§19 E10 止损线=900', near(mk[0].sl, 900));
    check('§19 E10 强平线=1000*(1-1/10)=900', near(mk[0].liq, 900), '' + mk[0].liq);
    check('§19 E10 入场 idx 命中（findIdxSync）', mk[0].entryIdx >= 0, '' + mk[0].entryIdx);

    // E3 加仓接线
    API.simAddAtCursor({ sym: 'BTC', period: '1d', price: 1100, ts: 200, size: 1, stop: 950 });
    const mk2 = API.simMarks('BTC', '1d', 200);
    check('§19 E3 控制器加仓：legs=2', mk2[0].committed === 2, '' + mk2[0].committed);
    check('§19 E3 加仓后均价=(1000+1100)/2=1050', near(mk2[0].entryPrice, 1050), '' + mk2[0].entryPrice);

    // E4 平半/平全接线 + 退出标注
    API.simExitAtCursor('half', { sym: 'BTC', period: '1d', price: 1200, ts: 300 });
    let mk3 = API.simMarks('BTC', '1d', 300);
    check('§19 E4 控制器平半：退出含 kind=half', mk3[0].exits.some(e => e.kind === 'half'));
    check('§19 E4 平半后剩余 size=1', near(mk3[0].size, 1), '' + mk3[0].size);
    API.simExitAtCursor('full', { sym: 'BTC', period: '1d', price: 1300, ts: 400 });
    mk3 = API.simMarks('BTC', '1d', 400);
    check('§19 E4 控制器平全：status=closed', mk3[0].status === 'closed');
    check('§19 E4 平全退出含 kind=full', mk3[0].exits.some(e => e.kind === 'full'));
    check('§19 E4 已实现累加>0', mk3[0].realized > 0, '' + mk3[0].realized.toFixed(2));

    // E10 面板/渲染不抛异常（drawSim 依赖 canvas stub）
    let threw = false;
    try { API.drawSim(); API.renderSim(); API.draw(); } catch (e) { threw = true; }
    check('§19 E10 drawSim/renderSim/draw 不抛异常', !threw);

    // simCursorTs 回退：无悬停时返回数据范围内 ts
    API.simClearAll();
    const cts = API.simCursorTs();
    const allTs = DATA['1d'].map(b => b[0]);
    check('§19 simCursorTs 回退到数据范围内', cts != null && cts >= Math.min.apply(null, allTs) && cts <= Math.max.apply(null, allTs), '' + cts);

    API.simClearAll();
  }

  // ============ 19.6 持久化 + 操作记录（E7 刷新恢复、E8 切换独立） ============
  {
    // E7：开仓→平仓→写入 localStorage；模拟刷新（清空内存再 loadSim）应恢复
    API.simClearAll();
    API.simOpen({ sym: 'BTC', period: '1d', side: 'long', leverage: 10, size: 1, stop: 900, ts: 100, price: 1000 });
    API.simExit({ sym: 'BTC', period: '1d', kind: 'full', price: 1100, ts: 200 }); // 已实现 100
    API.simDropMemory();
    check('§19 E7 刷新前内存已清空', Object.keys(API.getSimStore()).length === 0);
    API.loadSim();
    const stR = API.getSimStore()['BTC|1d'];
    check('§19 E7 刷新后从 localStorage 恢复持仓', !!stR && stR.positions.length === 1);
    check('§19 E7 刷新后恢复已实现盈亏=100', !!stR && near(API.simRealizedPnl(stR.positions[0]), 100), '' + (!!stR ? API.simRealizedPnl(stR.positions[0]) : 'null'));
    check('§19 E7 刷新后恢复操作记录=2 条', !!stR && stR.log.length === 2, '' + (!!stR ? stR.log.length : 'null'));

    // E8：不同周期持仓相互独立存储与读取
    API.simClearAll();
    API.simOpen({ sym: 'BTC', period: '1d', side: 'long', leverage: 10, size: 1, ts: 100, price: 1000 });
    API.simOpen({ sym: 'BTC', period: '4h', side: 'short', leverage: 5, size: 2, ts: 100, price: 2000 });
    const store8 = API.getSimStore();
    check('§19 E8 两周期独立存储键 BTC|1d / BTC|4h', !!store8['BTC|1d'] && !!store8['BTC|4h']);
    const mk1 = API.simMarks('BTC', '1d', 100);
    const mk4 = API.simMarks('BTC', '4h', 100);
    check('§19 E8 1d 仅含 1d 持仓（多/10x）', mk1.length === 1 && mk1[0].side === 'long' && mk1[0].leverage === 10);
    check('§19 E8 4h 仅含 4h 持仓（空/5x）', mk4.length === 1 && mk4[0].side === 'short' && mk4[0].leverage === 5);

    API.simClearAll();
  }

  // ============ 20. 年度分隔（交替底色 / 年界细线 / 年份标签） ============
  {
    await API.setView(null, '1d');
    const L = API.dataLen();
    // 全量视图必然跨多年 → 应画出多个年份标签
    API.setViewRange(0, L);
    ctxTexts.length = 0;
    let threw = null;
    try { API.draw(); } catch (e) { threw = e; }
    check('§20 跨年全量视图 draw 不抛异常', threw === null, threw ? threw.message : '');
    const yrs = ctxTexts.filter(t => /^(19|20)\d{2}$/.test(t));
    check('§20 跨年视图出现多个年份标签', yrs.length >= 3, yrs.join(','));

    // 窄视图（最近 60 根 1d，通常落在同一年）→ 不应画年界标签
    API.setViewRange(Math.max(0, L - 60), 60);
    ctxTexts.length = 0;
    threw = null;
    try { API.draw(); } catch (e) { threw = e; }
    const yrs2 = ctxTexts.filter(t => /^(19|20)\d{2}$/.test(t));
    check('§20 单年窄视图不画年界标签', threw === null && yrs2.length <= 1, yrs2.join(','));
  }

  // ============ 21. 成交量基准：跨缩放不断层 + 不顶满 + 平移稳定（§14b 回归） ============
  {
    const volH = 700 * API.getVolFrac();
    // 成交量柱共用同一个底边 volBot，取「出现次数最多的底边」即可自动定位（不依赖硬编码坐标）
    const volBotOf = rects => {
      const cnt = new Map();
      for (const r of rects) {
        const b = +(r[1] + r[3]).toFixed(2);
        if (b < 400) continue;
        cnt.set(b, (cnt.get(b) || 0) + 1);
      }
      let bot = 0, best = 0;
      for (const [b, c] of cnt) if (c > best) { best = c; bot = b; }
      return bot;
    };
    const statNow = () => {
      ctxRects.length = 0; API.draw();
      const bot = volBotOf(ctxRects);
      const hs = ctxRects
        .filter(r => bot > 0 && Math.abs(r[1] + r[3] - bot) < 0.6 && r[3] > 0.5 && r[3] < 260)
        .map(r => r[3]).sort((a, b) => a - b);
      const n = hs.length;
      return { n, med: n ? hs[Math.floor(n / 2)] : 0, clip: n ? hs.filter(h => h > volH * 0.97).length / n : 0 };
    };
    const warm = () => { for (let k = 0; k < 80; k++) API.draw(); };   // 收敛 §14 平滑

    await API.setView(null, '15m');
    const L = API.dataLen();
    // 卡在 xW=1 两侧各取一档：旧版此处基准口径切换（单根最大 vs 桶和最大），柱高中位能差好几倍
    API.setViewRange(Math.max(0, L - 600), 600); warm();
    const a = statNow();
    API.setViewRange(Math.max(0, L - 1200), 1200); warm();
    const b = statNow();
    const ratio = (a.med > 0 && b.med > 0) ? Math.max(a.med, b.med) / Math.min(a.med, b.med) : 999;
    check('§21 跨 xW=1 柱高尺度不断层（中位比<3x）', ratio < 3,
      'vc600=' + a.med.toFixed(1) + ' vc1200=' + b.med.toFixed(1) + ' ratio=' + ratio.toFixed(2));
    check('§21 成交量不出现大面积顶满（顶格比≤15%）', a.clip <= 0.15 && b.clip <= 0.15,
      (a.clip * 100).toFixed(1) + '% / ' + (b.clip * 100).toFixed(1) + '%');

    // 全量档连续平移：基准应平滑（旧版相邻跳变最高 25.6%）
    API.setViewRange(0, L); warm();
    const seq = [];
    for (let k = 0; k < 12; k++) { key('ArrowLeft'); API.draw(); seq.push(API.getVolNormSmooth()); }
    const jumps = seq.slice(1).map((v, k) => Math.abs(v - seq[k]) / Math.max(1, seq[k]));
    const maxJump = Math.max.apply(null, jumps);
    check('§21 大缩放平移时成交量基准稳定（相邻跳变<5%）', maxJump < 0.05, (maxJump * 100).toFixed(1) + '%');

    // 1d 全量档同样不该顶满（历史段/追加段量纲必须一致）
    await API.setView(null, '1d');
    const L1 = API.dataLen();
    API.setViewRange(0, L1); warm();
    const d = statNow();
    check('§21 1d 全量视图成交量不顶满（顶格比≤15%）', d.clip <= 0.15, (d.clip * 100).toFixed(1) + '%');
  }

  // ============ 22. 数据口径完整性（直接跑 CI 用的同一份 validate_data.cjs） ============
  {
    const { execFileSync } = require('child_process');
    let out = '', code = 0;
    try {
      out = execFileSync(process.execPath, ['validate_data.cjs'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    } catch (e) {
      code = e.status;
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    const tail = out.trim().split('\n').slice(-1)[0] || '';
    check('§22 validate_data.cjs 通过（含时间轴/量能口径检查）', code === 0, tail);
    const m = out.match(/量能口径检查: 最大台阶 ×([\d.]+)/);
    check('§22 全历史无 >20 倍量能台阶（单位口径一致）', !!m && +m[1] < 20,
      m ? 'max ×' + m[1] : '未取到输出');
  }

  // ============ 23. 渲染快照（RENDER=1 时额外导出 PNG，供肉眼复核） ============
  {
    if (process.env.RENDER) {
      const shot = tag => {
        require('fs').writeFileSync('/tmp/shot_' + tag + '.png', canvasMock.toBuffer('image/png'));
        console.log('§23 wrote /tmp/shot_' + tag + '.png');
      };
      for (const spec of [
        ['1d', null],           // 默认视图
        ['1d', 260],
        ['1d', 900],
        ['15m', null],
        ['15m', 246893]
      ]) {
        const per = spec[0], vc = spec[1];
        await API.setView(null, per);
        const L = API.dataLen();
        if (vc) API.setViewRange(Math.max(0, L - vc), Math.min(vc, L));
        for (let k = 0; k < 90; k++) API.draw();
        shot(per + '_' + (vc || 'default'));
      }
    }
  }

  // ============ 24. 供应线（绿）/ 需求线（红）水平线类型 ============
  {
    const st = (() => { try { return API.getHLevelStyle(); } catch (e) { return null; } })();
    check('§24 HLEVEL_STYLE 已定义 supply/demand', !!st && !!st.supply && !!st.demand);
    check('§24 供应线配色为绿 #2fbf71', !!st && st.supply.color === '#2fbf71', st && st.supply.color);
    check('§24 需求线配色为红 #ef4d4d', !!st && st.demand.color === '#ef4d4d', st && st.demand.color);
    check('§24 名称标签为 供应线/需求线', !!st && st.supply.label === '供应线' && st.demand.label === '需求线');

    // 供应线：单点创建 + 命中 + 拖动
    API.setTool('supply');
    down(420, 260);
    let arr = API.getLines();
    const sp = arr[arr.length - 1];
    check('§24 供应线单点创建', !!sp && sp.type === 'supply' && near(sp.price, API.yToPrice(260)));
    check('§24 供应线创建后自动退出工具', API.getTool() === 'cursor');
    const hSp = API.hitTest(420, 260);
    check('§24 供应线命中 body', !!hSp && hSp.handle === 'body');
    down(420, 260); move(420, 300);
    check('§24 供应线拖动改价', !!sp && near(sp.price, API.yToPrice(300)));
    up(); move(-1, -1);

    // 需求线：单点创建 + 命中 + 拖动
    API.setTool('demand');
    down(520, 480);
    arr = API.getLines();
    const dm = arr[arr.length - 1];
    check('§24 需求线单点创建', !!dm && dm.type === 'demand' && near(dm.price, API.yToPrice(480)));
    check('§24 需求线创建后自动退出工具', API.getTool() === 'cursor');
    const hDm = API.hitTest(520, 480);
    check('§24 需求线命中 body', !!hDm && hDm.handle === 'body');
    down(520, 480); move(520, 440);
    check('§24 需求线拖动改价', !!dm && near(dm.price, API.yToPrice(440)));
    up(); move(-1, -1);

    // 标签文本（draw 的 fillText 记录）：§26 起改为「只留名称、不给价格数值」
    let n0 = ctxTexts.length; API.draw();
    const tSpArr = ctxTexts.slice(n0).filter(t => t.includes('供应线'));
    check('§24/§26 供应线标签恰为「供应线」', tSpArr.includes('供应线'), JSON.stringify(tSpArr));
    check('§24/§26 供应线标签不含任何数字', tSpArr.length > 0 && !tSpArr.some(t => /\d/.test(t)), JSON.stringify(tSpArr));
    n0 = ctxTexts.length; API.draw();
    const tDmArr = ctxTexts.slice(n0).filter(t => t.includes('需求线'));
    check('§24/§26 需求线标签恰为「需求线」', tDmArr.includes('需求线'), JSON.stringify(tDmArr));
    check('§24/§26 需求线标签不含任何数字', tDmArr.length > 0 && !tDmArr.some(t => /\d/.test(t)), JSON.stringify(tDmArr));

    // 持久化（创建走 500ms 防抖，显式落盘一次再断言）
    API.saveSessionNow();
    const raw = store['kline_session_v1'] || '';
    check('§24 供应线/需求线已持久化到 session',
      raw.includes('"type":"supply"') && raw.includes('"type":"demand"'), raw.length + ' bytes');

    // 共存 + 删除（互不干扰）
    check('§24 供应线与需求线共存', API.getLines().some(l => l.type === 'supply') && API.getLines().some(l => l.type === 'demand'));
    const nAll = API.getLines().length;
    check('§24 供应线删除', !!sp && deleteLine('supply', sp));
    check('§24 需求线删除', !!dm && deleteLine('demand', dm));
    check('§24 删除只减少两条，其余不受影响', API.getLines().length === nAll - 2, '' + API.getLines().length);
  }

  // ============ 25. 水平通道配色：上线绿（供应）/ 下线红（需求） ============
  {
    const st = (() => { try { return API.getHChannelStyle(); } catch (e) { return null; } })();
    check('§25 HCHANNEL_STYLE 已定义 up/dn', !!st && !!st.up && !!st.dn);
    check('§25 上限线配色为绿 #2fbf71', !!st && st.up === '#2fbf71', st && st.up);
    check('§25 下限线配色为红 #ef4d4d', !!st && st.dn === '#ef4d4d', st && st.dn);
    const hl = API.getHLevelStyle();
    check('§25 与供应线/需求线同色（单一来源）',
      !!st && !!hl && st.up === hl.supply.color && st.dn === hl.demand.color);

    // 建一条「上高下低」的水平通道，用绘制的 stroke 记录校验颜色 ↔ 价位
    // 注：蜡烛 wick 也用同色 stroke，故只取该次 draw 的「末两条」——lines 里通道是最后一个对象，
    //     drawLines() 的画序（上限绿 → 下限红）保证这两条 stroke 就是通道自身的两条线。
    API.setTool('hchannel');
    down(500, 200);   // 上限（高价）
    down(500, 400);   // 下限（低价）
    const arr = API.getLines();
    const hc = arr[arr.length - 1];
    check('§25 水平通道两点创建', !!hc && hc.type === 'hchannel' &&
      near(hc.price1, API.yToPrice(200)) && near(hc.price2, API.yToPrice(400)));
    check('§25 创建后自动退出工具', API.getTool() === 'cursor');

    const n0 = ctxStrokes.length; API.draw();
    const seg = ctxStrokes.slice(n0).filter(s => s.color === '#2fbf71' || s.color === '#ef4d4d');
    check('§25 通道两条线各画一次（绿 + 红）',
      seg.filter(s => s.color === '#2fbf71').length >= 1 && seg.filter(s => s.color === '#ef4d4d').length >= 1);
    const t2 = seg.slice(-2);
    const yHi = API.priceToY(Math.max(hc.price1, hc.price2));   // 高价线 y（更小）
    const yLo = API.priceToY(Math.min(hc.price1, hc.price2));   // 低价线 y（更大）
    check('§25 上限（高价）绿线、下限（低价）红线', t2.length === 2 &&
      t2[0].color === '#2fbf71' && Math.abs(t2[0].y - yHi) < 0.5 &&
      t2[1].color === '#ef4d4d' && Math.abs(t2[1].y - yLo) < 0.5,
      t2.map(s => s.color + '@y' + (s.y == null ? '?' : s.y.toFixed(1))).join(' ') +
      ' 期望 #2fbf71@y' + yHi.toFixed(1) + ' #ef4d4d@y' + yLo.toFixed(1));

    // 价格反转（先点低价再点高价）时，颜色仍按「高价绿 / 低价红」分配
    API.setTool('hchannel');
    down(500, 420); down(500, 180);
    const hc2 = API.getLines()[API.getLines().length - 1];
    const n1 = ctxStrokes.length; API.draw();
    const seg2 = ctxStrokes.slice(n1).filter(s => s.color === '#2fbf71' || s.color === '#ef4d4d');
    const t2b = seg2.slice(-2);
    const yHi2 = API.priceToY(Math.max(hc2.price1, hc2.price2));
    const yLo2 = API.priceToY(Math.min(hc2.price1, hc2.price2));
    check('§25 反向点选仍为「高价绿/低价红」', t2b.length === 2 &&
      t2b[0].color === '#2fbf71' && Math.abs(t2b[0].y - yHi2) < 0.5 &&
      t2b[1].color === '#ef4d4d' && Math.abs(t2b[1].y - yLo2) < 0.5,
      t2b.map(s => s.color + '@y' + (s.y == null ? '?' : s.y.toFixed(1))).join(' '));
    check('§25 反向通道删除', !!hc2 && deleteLine('hchannel', hc2));

    check('§25 通道删除', !!hc && deleteLine('hchannel', hc));
  }

  // ============ 26. 供应/需求线：不给数值 + 上下移动（拖动 / ↑↓）+ 记忆 ============
  {
    const px = (p, d) => API.yToPrice(API.priceToY(p) + d);   // 按屏幕像素位移换算价格
    API.clearLines();

    // --- ① 标注只留名称、不带价格数值 ---
    API.setTool('supply');
    down(420, 300);
    const sp = API.getLines()[API.getLines().length - 1];
    check('§26 供应线已创建', !!sp && sp.type === 'supply' && near(sp.price, API.yToPrice(300)));
    let n0 = ctxTexts.length; API.draw();
    let texts = ctxTexts.slice(n0);
    check('§26 供应线标注恰为「供应线」（无价格）', texts.includes('供应线'), JSON.stringify(texts.filter(t => t.includes('供应线'))));
    check('§26 供应线标注不含数字', !texts.some(t => t.includes('供应线') && /\d/.test(t)));

    API.setTool('demand');
    down(520, 460);
    const dm = API.getLines()[API.getLines().length - 1];
    n0 = ctxTexts.length; API.draw();
    check('§26 需求线标注恰为「需求线」（无价格）', ctxTexts.slice(n0).includes('需求线'),
      JSON.stringify(ctxTexts.slice(n0).filter(t => t.includes('需求线'))));
    check('§26 需求线标注不含数字', !ctxTexts.slice(n0).some(t => t.includes('需求线') && /\d/.test(t)));

    // --- ② 先选后拖：整条线上下平移（画布内 move） ---
    down(420, API.priceToY(sp.price));          // 按下 = 选中该线
    up();
    check('§26 供应线可被选中', API.getSelected() === sp);
    down(420, API.priceToY(sp.price)); move(420, 380);
    check('§26 拖动整条线上下移动', near(sp.price, API.yToPrice(380)), sp.price + ' 期望 ' + API.yToPrice(380));
    up();

    // --- ③ 拖动时光标移出画布仍跟随（window mousemove 分支） ---
    down(420, API.priceToY(sp.price)); wmove(420, 250);
    check('§26 光标移出画布仍跟随', near(sp.price, API.yToPrice(250)), '' + sp.price);
    up();

    // --- ④ ↑/↓ 微调：2px/次，Shift ×5（10px）；↑ = 价格上行 ---
    const p0 = sp.price;
    key('ArrowUp');
    check('§26 ↑ 上移 2px（价格变高）', near(sp.price, px(p0, -2)), p0 + ' → ' + sp.price);
    key('ArrowDown'); key('ArrowDown');
    check('§26 ↓ 下移 2px（两次回落到 +2px）', near(sp.price, px(p0, 2)), p0 + ' → ' + sp.price);
    const pA = sp.price;
    keyShift('ArrowUp');
    check('§26 Shift+↑ 步长 10px', near(sp.price, px(pA, -10)), pA + ' → ' + sp.price);
    const pB = sp.price;
    keyShift('ArrowDown');
    check('§26 Shift+↓ 步长 10px', near(sp.price, px(pB, 10)), pB + ' → ' + sp.price);

    // --- ⑤ 记忆：等 500ms 防抖后从 localStorage 读回，价格与拖动结果一致 ---
    const pNudged = sp.price;
    await sleep(700);
    let saved = {};
    try { saved = JSON.parse(store['kline_session_v1'] || '{}'); } catch (e) {}
    const savedLines = (saved.linesStore && saved.linesStore.BTC) || [];
    const savedSp = savedLines.find(l => l.type === 'supply');
    check('§26 微调后的价格已写入 localStorage', !!savedSp && savedSp.price === pNudged,
      savedSp ? 'saved=' + savedSp.price + ' 期望=' + pNudged : '未找到 supply');
    const savedDm = savedLines.find(l => l.type === 'demand');
    check('§26 需求线一并被记住', !!savedDm && savedDm.price === dm.price, savedDm ? '' + savedDm.price : '未找到 demand');

    // --- ⑥ 选中的是别的类型时不误移 ---
    API.setTool('trend'); down(200, 500); down(320, 440);
    const tr = API.getLines()[API.getLines().length - 1];
    check('§26 趋势线已创建', !!tr && tr.type === 'trend');
    down(sx(API.lnIdx(tr, 'x1')), sy(tr.y1)); up();
    check('§26 趋势线已被选中', API.getSelected() === tr);
    const ty1 = tr.y1, ty2 = tr.y2;
    key('ArrowUp'); key('ArrowDown');
    check('§26 斜线不受 ↑↓ 影响', tr.y1 === ty1 && tr.y2 === ty2);
    check('§26 斜线未被误改价', near(sp.price, pNudged), '' + sp.price);

    // --- ⑦ 水平通道：↑/↓ 整体平移，区间宽度不变 ---
    API.setTool('hchannel'); down(500, 200); down(500, 400);
    const hc = API.getLines()[API.getLines().length - 1];
    check('§26 水平通道已创建', !!hc && hc.type === 'hchannel');
    down(500, sy(hc.price1)); up();
    check('§26 水平通道整体被选中', API.getSelected() === hc);
    const gapPx = Math.abs(API.priceToY(hc.price1) - API.priceToY(hc.price2));
    const hcP1 = hc.price1, hcP2 = hc.price2;
    key('ArrowUp');
    check('§26 通道整体上移（两条边同步）', near(hc.price1, px(hcP1, -2)) && near(hc.price2, px(hcP2, -2)),
      `${hcP1}→${hc.price1} / ${hcP2}→${hc.price2}`);
    check('§26 通道上下边间距不变', Math.abs(Math.abs(API.priceToY(hc.price1) - API.priceToY(hc.price2)) - gapPx) < 1e-6,
      'gap ' + gapPx.toFixed(3));
    deleteLine('hchannel', hc);
    deleteLine('trend', tr);
    deleteLine('supply', sp);
    deleteLine('demand', dm);
    check('§26 清理完成', API.getLines().length === 0, '' + API.getLines().length);

    // --- ⑧ 肉眼复核（RENDER=1）：三条水平线并列，确认标注只剩名称、没有价格数字 ---
    if (process.env.RENDER) {
      await API.setView(null, '1d');
      const L = API.dataLen();
      API.setViewRange(Math.max(0, L - 260), Math.min(260, L));
      for (let k = 0; k < 90; k++) API.draw();
      API.setTool('supply'); down(420, 180);      // 上方绿色「供应线」
      API.setTool('demand'); down(520, 560);      // 下方红色「需求线」
      API.setTool('hchannel'); down(300, 250); down(300, 450);   // 水平通道（应无任何标注）
      for (let k = 0; k < 90; k++) API.draw();
      require('fs').writeFileSync('/tmp/shot_levels.png', canvasMock.toBuffer('image/png'));
      console.log('§26 wrote /tmp/shot_levels.png');
    }
  }

  // ============ 27. 工具条排序：模块 + 画线工具组内条目（拖拽自定义 + 记忆） ============
  {
    const root = mkBar();
    const keys = () => API.szKids(root).map(API.szKey);
    const T = root.querySelector('.group.tools');
    const toolKeys = () => API.szKids(T).map(API.szKey);
    const g = k => API.szKids(root).find(n => API.szKey(n) === k);
    const rect = n => n.getBoundingClientRect();

    check('§27 模块键齐全且按 DOM 顺序',
      keys().join(',') === 'symbols,periods,ma,tools,axis,view,memory,focus,trades,sim', keys().join(','));
    check('§27 标题不是模块、不参与排序', !keys().includes('title'));
    check('§27 画线工具组内条目键齐全',
      toolKeys().join(',') === 'tool:cursor,tool:hline,#clearLines,#tradeEnter,#tradeDirSeg,cont', toolKeys().join(','));
    check('§27 键的优先级 dataset.key > id > data-tool',
      API.szKey(g('symbols')) === 'symbols' && API.szKey(API.szKids(T)[2]) === '#clearLines' &&
      API.szKey(API.szKids(T)[0]) === 'tool:cursor');

    // --- 拖动落点：按 y 找最近兄弟，上半 → 插前，下半 → 插后 ---
    check('§27 已在原位时拖动返回 false（不做无谓改动）', API.szMoveTo(root, g('symbols'), 10) === false);
    check('§27 拖到最上 → 变成第 1 个模块',
      API.szMoveTo(root, g('tools'), rect(g('symbols')).top + 5) === true && keys()[0] === 'tools', keys().join(','));
    const fr = rect(g('focus'));
    check('§27 拖到 focus 下半区 → 插到 focus 之后',
      API.szMoveTo(root, g('tools'), fr.top + fr.height * 0.75) === true &&
      keys().indexOf('tools') === keys().indexOf('focus') + 1, keys().join(','));
    const ar = rect(g('axis'));
    check('§27 再拖回 axis 之前',
      API.szMoveTo(root, g('tools'), ar.top + 1) === true && keys().indexOf('tools') === keys().indexOf('axis') - 1,
      keys().join(','));
    check('§27 y 远超下方 → 落到最后一个模块',
      API.szMoveTo(root, g('tools'), 99999) === true && keys()[keys().length - 1] === 'tools', keys().join(','));

    // --- 组内条目（画线工具）同样能排 ---
    check('§27 组内把第一项拖到末尾',
      API.szMoveTo(T, API.szKids(T)[0], 99999) === true && toolKeys()[toolKeys().length - 1] === 'tool:cursor',
      toolKeys().join(','));
    const lastTool = toolKeys()[toolKeys().length - 1];
    check('§27 组内把末项拖到最上',
      API.szMoveTo(T, API.szKids(T)[API.szKids(T).length - 1], -99999) === true && toolKeys()[0] === lastTool,
      lastTool + ' → 队首 | ' + toolKeys().join(','));

    // --- 落盘 / 还原 ---
    const snap = API.szOrderOf(root);
    API.szSaveOrder(root);
    let raw = {};
    try { raw = JSON.parse(store[API.getSortKey()] || '{}'); } catch (e) {}
    check('§27 模块顺序写入 localStorage',
      !!raw.groups && raw.groups.join(',') === snap.groups.join(','), String(raw.groups));
    check('§27 组内条目顺序一并写入',
      !!raw.items && !!raw.items.tools && raw.items.tools.join(',') === snap.items.tools.join(','),
      String(raw.items && raw.items.tools));

    const rev = snap.groups.slice().reverse();
    API.szApplyOrder(root, { groups: rev, items: { tools: ['tool:cursor', '#id不存在', 'tool:hline'] } });
    check('§27 按记忆还原模块顺序', keys().join(',') === rev.join(','), keys().join(','));
    check('§27 未知键被忽略、未列出的条目留在末尾',
      toolKeys()[0] === 'tool:cursor' && toolKeys()[1] === 'tool:hline' && toolKeys().length === 6, toolKeys().join(','));

    store[API.getSortKey()] = '{"groups":["x"]}';
    API.szResetSort();
    check('§27 重置刷新会清掉排序记忆', !(API.getSortKey() in store), String(store[API.getSortKey()]));

    let threw = false;
    try {
      API.szApplyOrder(root, null);
      API.szApplyOrder(root, { groups: 'nope', items: {} });
      API.szApplyOrder(root, { groups: ['symbols'] });
    } catch (e) { threw = true; }
    check('§27 残缺/异常记忆不会让页面崩', threw === false && keys().length === 10, keys().join(','));

    // --- 静态检查真实 index.html：新增模块/按钮忘了给键会被这里抓住 ---
    const barHtml = html.slice(html.indexOf('<div id="toolbar">'), html.indexOf('<div id="main">'));
    // 注意正则要排除 .group-label：class="group[^"]*" 会把 10 个标签也数进来
    const gCount = (barHtml.match(/class="group(?: [^"]*)?"/g) || []).length;
    const kCount = (barHtml.match(/class="group(?: [^"]*)?"[^>]*data-key=/g) || []).length;
    check('§27 真实工具条每个模块都带 data-key', gCount === 10 && kCount === 10, gCount + ' 个模块 / ' + kCount + ' 个有键');
    const toolsHtml = barHtml.slice(barHtml.indexOf('class="group tools"'), barHtml.indexOf('data-key="axis"'));
    const iCount = (toolsHtml.match(/<(button|label|div)[^>]*(data-tool=|id="(clearLines|tradeEnter|tradeDirSeg)"|data-key="cont")/g) || []).length;
    check('§27 画线工具组内条目全部可识别（工具/连画/清除/盈亏比/多空）', iCount === 12, iCount + ' 项');
    check('§27 排序逻辑已注入页面', code.includes('function initSort()') && code.includes('kline_toolbar_order_v1'));
  }

  // ============ 28. 真 DOM（jsdom）端到端：派发真实鼠标事件走完整拖拽排序 ============
  // §27 用迷你 DOM 测的是「算法」；这里用真 DOM 测「交互」——真 HTML 结构 + 真事件 + 真 localStorage。
  // jsdom 没有布局引擎（getBoundingClientRect 全 0），所以手工合成纵向坐标：等价于「工具条是竖排的」这一事实。
  {
    const { JSDOM } = loadJsdom();
    if (!JSDOM) {
      console.log('SKIP  §28 未找到 jsdom（真 DOM 拖拽端到端验证跳过）');
      console.log('      装法：cd /Users/mac/.workbuddy/binaries/node/workspace && npm install jsdom');
    } else {
      const barHtml = html.slice(html.indexOf('<div id="toolbar">'), html.indexOf('<div id="main">'));
      const js = code;   // §30 起逻辑在 share/app.js，直接切片即可
      const s0 = js.indexOf('// ================= §27 工具条排序');
      const s1 = js.indexOf('initSort();', s0) + 'initSort();'.length;
      const block = js.slice(s0, s1);
      check('§28 从 share/app.js 抽到 §27 代码块', s0 > 0 && block.includes('function initSort') && block.includes('initSort();'),
        block.length + ' 字节');

      const store = {};
      const fakeLS = {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; }
      };
      const DEFAULT = 'symbols,periods,ma,tools,axis,view,memory,focus,trades,sim';
      let pend = [];                             // 可控定时器：模拟「200ms 过去了」
      const fakeSetTimeout = fn => { pend.push(fn); return pend.length; };
      const tick = () => { const t = pend; pend = []; t.forEach(f => f()); };
      const setRect = (el, top, h) => {
        el.getBoundingClientRect = () => ({ top, bottom: top + h, height: h, left: 0, right: 100, width: 100 });
      };
      // 真浏览器里布局永远跟着 DOM 实时更新；jsdom 没有布局引擎，所以每次交互前重算一遍合成坐标。
      const relayout = a => {
        let y = 20;
        for (const g of a.root.children) {
          if (g.classList.contains('group')) { setRect(g, y, 80); y += 100; } else setRect(g, 0, 20);
        }
        let ty = 2000;                            // 组内条目用独立区间，避免和模块区间重叠
        for (const it of a.T.children) { setRect(it, ty, 30); ty += 36; }
      };
      const boot = () => {                       // 每次调用 = 「打开/刷新一次页面」
        const dom = new JSDOM('<!doctype html><html><body>' + barHtml + '</body></html>',
          { url: 'https://t.test/', pretendToBeVisual: true });
        const { window } = dom;
        const fn = new Function('window', 'document', 'localStorage', 'setTimeout', 'clearTimeout', 'console', 'STORAGE_NS',
          block + '\n;return { root: document.getElementById("toolbar"), szOrderOf, szKey, szKids, szResetSort };');
        const api = fn(window, window.document, fakeLS, fakeSetTimeout, () => {}, console, '');   // '' = 复盘实例（不加前缀）
        const a = { window, api, root: api.root, T: api.root.querySelector('.group.tools'), items: 0 };
        a.items = a.T.children.length;
        relayout(a);
        return a;
      };
      const fire = (win, type, x, y, target) => {
        const ev = new win.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
        (target || win).dispatchEvent(ev);
        return ev;
      };
      const groupsOf = a => a.api.szOrderOf(a.root).groups.join(',');
      const itemsOf = a => a.api.szOrderOf(a.root).items.tools.join(',');
      const drag = (a, el, toY) => {
        relayout(a);
        fire(a.window, 'mousedown', 40, el.getBoundingClientRect().top + 6, el);
        fire(a.window, 'mousemove', 40, toY);
        fire(a.window, 'mouseup', 40, toY);
      };
      const nudge = (a, el, dy) => {              // 按住后小幅抖动（不换位）
        relayout(a);
        const t = el.getBoundingClientRect().top + 6;
        fire(a.window, 'mousedown', 40, t, el);
        fire(a.window, 'mousemove', 40, t + dy);
        fire(a.window, 'mouseup', 40, t + dy);
        return t + dy;
      };

      const A = boot();
      const maLabel = A.window.document.querySelector('.group[data-key="ma"] > .group-label');
      check('§28 真 HTML 里每个模块都能按 data-key 找到', !!maLabel && !!A.window.document.querySelector('.group[data-key="sim"]'));
      check('§28 首次打开 = 原始顺序', groupsOf(A) === DEFAULT, groupsOf(A));

      // ① 拖「均线」的标签到最顶部
      drag(A, maLabel, 25);
      check('§28 拖动模块标签 → DOM 真的换了位置', groupsOf(A) === 'ma,symbols,periods,tools,axis,view,memory,focus,trades,sim', groupsOf(A));
      check('§28 拖完立刻写入 localStorage',
        !!store['kline_toolbar_order_v1'] && JSON.parse(store['kline_toolbar_order_v1']).groups[0] === 'ma',
        String(store['kline_toolbar_order_v1']).slice(0, 60));

      // ② 拖「画线工具」组内第一个按钮到本组最末（组内真实条目数：12 个）
      const cursorBtn = A.window.document.querySelector('.group.tools button[data-tool="cursor"]');
      drag(A, cursorBtn, 2000 + (A.items - 1) * 36 + 28);
      check('§28 拖动组内按钮 → 工具顺序变化（挪到本组最末）',
        itemsOf(A).split(',').pop() === 'tool:cursor', itemsOf(A));

      // ③ 真拖动之后紧随的那一次 click 要被吞掉（否则会误点复选框/误切工具）
      const rl = () => { relayout(A); return maLabel.getBoundingClientRect(); };
      check('§28 拖完那一下 click 被吞掉', fire(A.window, 'click', 40, rl().top + 10, maLabel).defaultPrevented === true);
      // ④ 吞点击只针对「紧随那一次」：窗口过后再点必须正常放行（否则会连累别的按钮）
      tick();
      check('§28 窗口过后的点击正常放行',
        fire(A.window, 'click', 40, rl().top + 10, maLabel).defaultPrevented === false);

      // ⑤ 只点一下（没有位移）不该改变任何顺序，也不该吞 click
      const before = groupsOf(A);
      fire(A.window, 'mousedown', 40, rl().top + 10, maLabel);
      fire(A.window, 'mouseup', 40, rl().top + 10);
      check('§28 只点击不拖动 → 顺序不变', groupsOf(A) === before, groupsOf(A));
      check('§28 只点击不拖动 → click 正常放行',
        fire(A.window, 'click', 40, rl().top + 10, maLabel).defaultPrevented === false);

      // ⑥ 手抖式微拖（超过 5px 阈值、但没跨过任何兄弟）：不算排序，也不能吞 click，
      //    否则想点「水平线」时会因为手抖而点不动工具（这是最容易踩的手感坑）
      const hlineBtn = A.window.document.querySelector('.group.tools button[data-tool="hline"]');
      const itemsBefore = itemsOf(A);
      const hy = nudge(A, hlineBtn, 6);
      check('§28 手抖微拖 → 顺序不变', itemsOf(A) === itemsBefore, itemsOf(A));
      check('§28 手抖微拖 → click 未被吞（工具照样能选中）',
        fire(A.window, 'click', 40, hy, hlineBtn).defaultPrevented === false);

      // ⑦ 「刷新一次」：新开一个 DOM，共用同一份 localStorage
      const B = boot();
      check('§28 刷新后仍按记忆的顺序', groupsOf(B) === groupsOf(A), groupsOf(B) + ' vs ' + groupsOf(A));
      check('§28 且确实不是原始顺序（证明真读了记忆）', groupsOf(B) !== DEFAULT, groupsOf(B));

      // ⑧ 重置刷新 → 还原默认并清记忆
      B.api.szResetSort();
      check('§28 重置刷新 → 回到原始顺序', groupsOf(B) === DEFAULT, groupsOf(B));
      check('§28 重置刷新 → 清掉排序记忆', !('kline_toolbar_order_v1' in store), String(store['kline_toolbar_order_v1']));
      check('§28 重置刷新按钮已接上排序还原', code.includes('szResetSort();   // §27'));
      check('§28 拖拽样式已注入（.sz-drag / cursor:grab）',
        html.includes('.sz-drag {') && html.includes('cursor: grab;'));
    }
  }

  // ============ 29. 重叠对象也能选中并删除（用户报告：供应线落在水平通道带里时点不到） ============
  // 旧版 hitTest：从最新往最旧扫、命中即 return。对象一重叠就让被压住的那条永远选不中 → 也就删不掉：
  //   ① 先画供应线、后画把它包住的水平通道 → 通道带（面）先命中，供应线点不到；
  //   ② 供应线与水平线几乎同价 → 只有后画的那条能选中。
  // §29 改为「收集全部候选 + 排序（手柄0 < 细线1 < 面2，同优先级比距离，同距比新旧）」，
  //     并在 mousedown 里做「同一位置再点一次 → 轮换到下一个候选」。
  {
    const yOf = p => API.priceToY(p);
    const last = () => API.getLines()[API.getLines().length - 1];
    // ⚠️ 坐标一律按真实 SCALE 锚定，别硬编码：更早的用例会把 volFrac 拖到 0.317，
    //    此时 mainBot 只有 418（成交量分隔条在 ~422），硬编码 y=420 会正好压在分隔条上 → 点击被当成「拖 VOL 高度」。
    const sc0 = API.getScale();
    const yA = f => Math.round(sc0.mainTop + (sc0.mainBot - sc0.mainTop) * f);
    const Y_TOP = yA(0.15), Y_BOT = yA(0.92), Y_MID = yA(0.50);

    // ---- 29.1 复现原始 bug：先画供应线，再画把它包在里面的水平通道 ----
    clearLines();
    API.setTool('supply'); down(600, Y_MID);
    const spA = last();
    API.setTool('hchannel'); down(400, Y_TOP); down(400, Y_BOT);
    const hcA = last();
    const ySpA = yOf(spA.price);
    check('§29 场景就位：供应线落在水平通道带内部',
      !!spA && !!hcA && spA.type === 'supply' && hcA.type === 'hchannel' &&
      ySpA > Math.min(yOf(hcA.price1), yOf(hcA.price2)) && ySpA < Math.max(yOf(hcA.price1), yOf(hcA.price2)),
      'sp@' + ySpA.toFixed(0) + ' band ' + yOf(hcA.price1).toFixed(0) + '~' + yOf(hcA.price2).toFixed(0));

    const cA = API.hitTestAll(500, ySpA);
    check('§29 首次命中即供应线（不再被通道带吞掉）', cA.length > 1 && cA[0].line === spA,
      cA.map(c => c.line.type + '/' + c.handle + '/prio' + c.prio).join(' > '));
    check('§29 通道带仍是候选（没丢，只是排后）', cA.some(c => c.line === hcA));
    check('§29 带内「面」优先级最低 prio=2', cA.find(c => c.line === hcA).prio === 2);
    check('§29 细线 prio=1（高于带内面）', cA[0].prio === 1);

    // 端到端：点 → 选中 → Del → 真删掉
    down(500, ySpA);
    check('§29 点击带内供应线 → 选中供应线', API.getSelected() === spA);
    up();
    key('Delete');
    check('§29 Del 真的删掉供应线（用户诉求达成）', !API.getLines().includes(spA), '剩余 ' + API.getLines().length + ' 条');
    check('§29 通道带未被误删', API.getLines().includes(hcA));

    // ---- 29.2 水平通道自身：带边 prio=1 高于带内面 prio=2 ----
    clearLines();
    API.setTool('hchannel'); down(400, Y_TOP); down(400, Y_BOT);
    const hcB = last();
    const yEdgeB = yOf(hcB.price1);
    const cEdge = API.hitTestAll(500, yEdgeB);
    check('§29 带边命中 p1 且 prio=1', cEdge.length >= 1 && cEdge[0].handle === 'p1' && cEdge[0].prio === 1,
      cEdge.map(c => c.handle + '/prio' + c.prio).join(' > '));
    const midB = (yOf(hcB.price1) + yOf(hcB.price2)) / 2;
    const cMid = API.hitTestAll(500, midB);
    check('§29 带内空白只命中通道本体 body 且 prio=2',
      cMid.length === 1 && cMid[0].line === hcB && cMid[0].handle === 'body' && cMid[0].prio === 2,
      cMid.map(c => c.handle + '/prio' + c.prio).join(' > '));
    // 带内空白点击仍能选中通道本体（可平移）
    down(500, midB);
    check('§29 带内空白仍可选中通道本体', API.getSelected() === hcB);
    up();

    // ---- 29.3 两条单点水平线完全重合：同点再点一次 → 轮换 ----
    clearLines();
    API.setTool('hline'); down(500, Y_MID);
    const hlC = last();
    API.setTool('supply'); down(500, Y_MID);          // 与水平线同价位
    const spC = last();
    const yC = yOf(spC.price);
    check('§29 两条单点水平线真重合', !!hlC && !!spC && near(hlC.price, spC.price, 1e-9));
    const cC = API.hitTestAll(500, yC);
    check('§29 重合处两个候选都在', cC.length === 2 && cC.some(c => c.line === hlC) && cC.some(c => c.line === spC));
    check('§29 完全同距时越新越优先（供应线在后 → 先命中）', cC[0].line === spC);

    down(500, yC);
    check('§29 第一次点 → 选中供应线', API.getSelected() === spC);
    up();
    down(500, yC);
    check('§29 同点再点一次 → 轮换到被压住的水平线（关键修复）', API.getSelected() === hlC);
    up();
    down(500, yC);
    check('§29 再点一次 → 循环回供应线', API.getSelected() === spC);
    up();
    key('Delete');
    check('§29 轮换后 Del 删掉的正是轮换到的那条', !API.getLines().includes(spC) && API.getLines().includes(hlC));

    down(500, yC);
    check('§29 只剩一条时同点点击直接选中它', API.getSelected() === hlC);
    up();

    // ---- 29.4 轮换以「位置」为界：点到别处再回来 → 回到首选 ----
    clearLines();
    API.setTool('hline'); down(500, Y_MID);
    API.setTool('demand'); down(500, Y_MID);
    const dmD = last();
    const yD = yOf(dmD.price);
    down(500, yD);
    check('§29 首选 = 后画的需求线', API.getSelected() === dmD);
    up();
    down(800, Y_TOP + 20);                                   // 点到别处（空处 → 取消选中）
    up();
    check('§29 点到别处 → 取消选中', API.getSelected() === null);
    down(500, yD);
    check('§29 回到原位置 → 重新从首选开始（不记忆轮换位）', API.getSelected() === dmD);
    up();

    // ---- 29.5 重叠提示：画布上出现「重叠 N 个对象 · 再点一次切换」 ----
    move(500, yD);
    let n0 = ctxTexts.length; API.draw();
    const badge = ctxTexts.slice(n0).filter(t => /重叠 \d+ 个对象/.test(t));
    check('§29 重叠处给出可切换提示', badge.length === 1, JSON.stringify(badge.slice(0, 2)));
    check('§29 提示里报出的重叠数量正确', badge.length === 1 && badge[0].indexOf('重叠 2 个') === 0, badge[0] || '');

    // 不重叠时不该刷提示
    down(800, Y_TOP + 20); up();                             // 取消选中
    API.setLastPick(null);
    move(300, Y_BOT + 40);                            // 主图下方的空白（成交量副图区域）
    n0 = ctxTexts.length; API.draw();
    const badge2 = ctxTexts.slice(n0).filter(t => /重叠 \d+ 个对象/.test(t));
    check('§29 无重叠时不显示提示', badge2.length === 0, JSON.stringify(badge2.slice(0, 2)));

    // ---- 29.6 盈亏比面板：面板「空白面」不该吞掉穿过的供应线 ----
    move(-1, -1);
    clearLines();
    API.setTradeMode(true);
    goLatest();
    down(600, 400); move(600, 330); up(); move(600, 470); up();
    API.setTradeMode(false);
    const tr = API.getLines().find(l => l.type === 'trade');
    check('§29.6 盈亏比面板已创建', !!tr && tr.entry != null && tr.tp != null && tr.sl != null);
    if (tr) {
      // 在矩形横向范围内、且在矩形内部、离 tp/entry/sl 都超过 26px 的价位上放一条供应线
      const yMid = (yOf(tr.tp) + yOf(tr.sl)) / 2;
      API.setTool('supply'); down(600, yMid);
      const spE = last();
      check('§29.6 供应线落在面板矩形内部',
        !!spE && spE.type === 'supply' && Math.abs(yOf(spE.price) - yMid) < 1.5,
        'y=' + yOf(spE.price).toFixed(1) + ' 期望 ' + yMid.toFixed(1));
      const cE = API.hitTestAll(600, yOf(spE.price));
      check('§29.6 面板空白面不吞穿过的线（细线优先于面）',
        cE.length > 1 && cE[0].line === spE, cE.map(c => c.line.type + '/' + c.handle + '/prio' + c.prio).join(' > '));
      check('§29.6 面板本体仍是候选（prio=2）',
        cE.some(c => c.line === tr && c.prio === 2));
      check('§29.6 同点再点也能轮换到面板', (() => {
        down(600, yOf(spE.price)); const a = API.getSelected(); up();
        down(600, yOf(spE.price)); const b = API.getSelected(); up();
        return a === spE && b === tr;
      })());
    }

    // ---- 29.7 无重叠时的行为与旧版一致（回归保护） ----
    clearLines();
    check('§29.7 无画线时 hitTest 返回 null', API.hitTest(500, 300) === null);
    check('§29.7 无画线时候选为空数组', API.hitTestAll(500, 300).length === 0);
    API.setTool('demand'); down(500, Y_MID);
    const dmF = last();
    const cF = API.hitTestAll(500, yOf(dmF.price));
    check('§29.7 只有一条线 → 候选恰一个且就是它',
      cF.length === 1 && cF[0].line === dmF && cF[0].handle === 'body' && cF[0].prio === 1);
    check('§29.7 only-one 时 hitTest 仍返回 {line, handle} 结构', (() => {
      const r = API.hitTest(500, yOf(dmF.price));
      return !!r && r.line === dmF && r.handle === 'body' && Object.keys(r).length === 2;
    })());
    check('§29.7 偏离 40px 仍点不中（容差没被放大）', API.hitTest(500, yOf(dmF.price) + 40) === null);
    check('§29.7 偏离 7px 仍点得中（容差没被缩小）', API.hitTest(500, yOf(dmF.price) + 5) !== null);
    // 单点水平线仍是单点拖动（§26 行为不能被改坏）
    const pBefore = dmF.price;
    down(500, yOf(dmF.price)); move(500, yOf(dmF.price) - 30); up();
    check('§29.7 单点水平线拖动仍然生效', !near(dmF.price, pBefore));
    clearLines();
    move(-1, -1);

    // ---- 29.8 肉眼复核（RENDER=1）：供应线压在水平通道带里 + 光标停在重叠处 → 应出现切换提示 ----
    if (process.env.RENDER) {
      await API.setView(null, '1d');
      const L2 = API.dataLen();
      API.setViewRange(Math.max(0, L2 - 260), Math.min(260, L2));
      const sc2 = API.getScale();
      const yy = f => Math.round(sc2.mainTop + (sc2.mainBot - sc2.mainTop) * f);
      API.setTool('supply'); down(620, yy(0.5));               // 绿：供应线（后画的通道把它包住）
      API.setTool('hchannel'); down(380, yy(0.14)); down(380, yy(0.9));
      for (let k = 0; k < 90; k++) API.draw();
      move(620, yy(0.5));                                      // 光标停在重叠处
      for (let k = 0; k < 5; k++) API.draw();
      require('fs').writeFileSync('/tmp/shot_overlap.png', canvasMock.toBuffer('image/png'));
      console.log('§29 wrote /tmp/shot_overlap.png');
    }
    clearLines();
  }

  // ============ 30. 双入口（复盘 / 看盘）+ 进度隔离 + 单一数据源 ============
  // 背景：两个入口都部署在 <user>.github.io 下，而 origin 只看「协议+域名」，不看路径
  //       —— 两个入口**共享** localStorage / IndexedDB。不隔离的话，一边的进度会覆盖另一边。
  // 结构：index.html（复盘壳） / live/index.html（看盘壳，由 build_live.cjs 生成）
  //       share/app.js（唯一逻辑） / share/data.js（唯一数据源，两个入口共用）
  {
    const REPO2 = path.join(__dirname, '..');
    const APP_SRC = fs.readFileSync(APP_JS, 'utf8');
    const IDX = html;
    const LIVE = fs.existsSync(path.join(REPO2, 'live', 'index.html'))
      ? fs.readFileSync(path.join(REPO2, 'live', 'index.html'), 'utf8') : '';

    // ---- 30.1 文件结构就位 ----
    check('§30 share/app.js 存在（唯一逻辑）', fs.existsSync(APP_JS));
    check('§30 share/data.js 存在（唯一数据源）', fs.existsSync(DATA_JS));
    check('§30 live/index.html 存在（看盘入口）', LIVE.length > 0, LIVE.length + ' 字节');

    // ---- 30.2 数据只有一份（防止以后又被内联回 HTML → 仓库每天多涨 17MB）----
    check('§30 复盘入口不含内联数据', !IDX.includes('window.BTCFUT_DATA='));
    check('§30 看盘入口不含内联数据', !LIVE.includes('window.BTCFUT_DATA='));
    check('§30 数据源里确实有 BTCFUT_DATA', DATA_JS && fs.readFileSync(DATA_JS, 'utf8').includes('window.BTCFUT_DATA='));

    // ---- 30.3 入口页引用路径 ----
    check('§30 复盘入口引用 share/data.js + share/app.js',
      IDX.includes('<script src="share/data.js"><\/script>') && IDX.includes('<script src="share/app.js"><\/script>'));
    check('§30 看盘入口引用 ../share/（多一层目录）',
      LIVE.includes('<script src="../share/data.js"><\/script>') && LIVE.includes('<script src="../share/app.js"><\/script>'));

    // ---- 30.4 实例标记 ----
    check('§30 复盘入口标记 review', /__APP_INSTANCE__\s*=\s*'review'/.test(IDX));
    check('§30 看盘入口标记 live', /__APP_INSTANCE__\s*=\s*'live'/.test(LIVE));
    check('§30 标题可区分（复盘/看盘）',
      IDX.includes('<title>BTC 时光机 · 复盘</title>') && LIVE.includes('<title>BTC 时光机 · 看盘</title>'));

    // ---- 30.5 看盘入口是生成物，必须与 index.html 同步（防改一边忘另一边）----
    let driftOk = false, driftMsg = '';
    try {
      const { buildLive } = require(path.join(REPO2, 'build_live.cjs'));
      const want = buildLive(IDX);
      driftOk = want === LIVE;
      driftMsg = driftOk ? '与 index.html 一致' : '不一致（跑 node build_live.cjs）';
    } catch (e) { driftMsg = '构建脚本不可用: ' + e.message; }
    check('§30 看盘入口与 index.html 完全同步（只有 3 处差异）', driftOk, driftMsg);

    // ---- 30.6 §30 命名空间：instance → 前缀 ----
    const begMark = '// ==== §30 INSTANCE NS BEGIN ====';
    const endMark = '// ==== §30 INSTANCE NS END ====';
    const b0 = APP_SRC.indexOf(begMark), b1 = APP_SRC.indexOf(endMark);
    check('§30 app.js 里有可切片的命名空间块', b0 > 0 && b1 > b0, (b1 - b0) + ' 字节');
    let nsOf = null;
    if (b0 > 0 && b1 > b0) {
      const block = APP_SRC.slice(b0, b1 + endMark.length);
      nsOf = marker => {
        const fn = new Function('window', block + '\n;return { APP_INSTANCE, STORAGE_NS };');
        return fn(typeof marker === 'undefined' ? {} : { __APP_INSTANCE__: marker });
      };
    }
    if (nsOf) {
      check('§30 复盘实例不加前缀（保住已有进度）', nsOf('review').STORAGE_NS === '', JSON.stringify(nsOf('review').STORAGE_NS));
      check('§30 看盘实例加 live__ 前缀', nsOf('live').STORAGE_NS === 'live__', nsOf('live').STORAGE_NS);
      check('§30 没注入标记时默认按复盘处理', nsOf().STORAGE_NS === '' && nsOf().APP_INSTANCE === 'review');
      // 组合出「真实键名」：复盘必须与历史键名完全一致，否则老进度读不出来
      const k = (ns, name) => ns.STORAGE_NS + name;
      check('§30 复盘键名与历史完全一致', k(nsOf('review'), 'kline_session_v1') === 'kline_session_v1');
      check('§30 看盘键名与复盘不再冲突', k(nsOf('live'), 'kline_session_v1') === 'live__kline_session_v1');
    }

    // ---- 30.7 六个存储点必须全部走 STORAGE_NS（漏一个就会互相覆盖）----
    {
      const names = ['kline_view_prefs_v1', 'kline_session_v1', 'kline_trades_v1', 'kline_sim_v1', 'kline_toolbar_order_v1', 'kline_cache_v1', 'focus_timer', 'focus_history'];
      const all = names.every(n => APP_SRC.includes("STORAGE_NS + '" + n + "'"));
      check('§30 8 个存储键（含 IndexedDB 库名与专注计时）全部带前缀', all,
        names.filter(n => !APP_SRC.includes("STORAGE_NS + '" + n + "'")).join(',') || '全部 OK');
      // 兜底：不能再出现「裸键名」写法（前面必须紧跟 STORAGE_NS + ）
      const bare = names.filter(n => new RegExp("(?<!STORAGE_NS \\+ )[\"']" + n + "[\"']").test(APP_SRC));
      check('§30 没有遗留的裸键名引用', bare.length === 0, bare.join(',') || '无');
    }

    // ---- 30.8 页面标题与实例挂钩（肉眼能分辨当前在哪个入口）----
    // §32 起多一态：watch（自选）—— 断言随实现一起更新
    check('§30 页内标题区分复盘/看盘/自选',
      APP_SRC.includes("(APP_INSTANCE === 'live' ? '（看盘）' : APP_INSTANCE === 'watch' ? '（自选）' : '（复盘）')"));

    // ---- 30.9 工具链已全部指向 share/data.js（防止改回去又内联）----
    const tool = f => fs.existsSync(path.join(REPO2, f)) ? fs.readFileSync(path.join(REPO2, f), 'utf8') : '';
    check('§30 update_data.cjs 写 share/data.js',
      /DATA_FILE = path\.join\(REPO, 'share', 'data\.js'\)/.test(tool('update_data.cjs')));
    check('§30 validate_data.cjs 读 share/data.js',
      /DATA_FILE = path\.join\(__dirname, 'share', 'data\.js'\)/.test(tool('validate_data.cjs')));
    check('§30 每日自动化只提交 share/data.js',
      tool('run_daily.sh').includes('git add share/data.js') && !/git add index\.html/.test(tool('run_daily.sh')));
    check('§30 Actions 只提交 share/data.js',
      tool('.github/workflows/daily-update.yml').includes('git add share/data.js'));

    // ---- 30.10 单文件离线版仍可造出来（本仓库曾经的核心卖点，不能被拆没）----
    {
      let okOff = false, msg = '';
      try {
        const shell = fs.readFileSync(path.join(REPO2, 'index.html'), 'utf8');
        const re = /<script src="share\/data\.js"><\/script>\s*<script src="share\/app\.js"><\/script>/;
        const single = shell.replace(re,
          '<script>\n' + fs.readFileSync(DATA_JS, 'utf8') + '\n</script>\n<script>\n' + APP_SRC + '\n</script>');
        okOff = re.test(shell) && single.includes('window.BTCFUT_DATA=') && !/src="share\//.test(single);
        msg = okOff ? '可内联成单文件' : '内联失败（结构变了？）';
      } catch (e) { msg = e.message; }
      check('§30 单文件离线版仍可构建（build_offline.cjs 逻辑有效）', okOff, msg);
    }
  }

  // ============ §31 看盘实例：直连 OKX 自动补数（方案 A，浏览器端，零仓库数据）============
  {
    // 快照/还原，避免污染前面的用例依赖的数据
    const snap = name => { const a = DATA[name]; return { a, n: a.length, tail: a.slice(-8).map(x => x.slice()) }; };
    const restore = s => {
      s.a.length = s.n;
      for (let i = 0; i < s.tail.length; i++) s.a[s.n - s.tail.length + i] = s.tail[i];
    };
    // OKX 原始蜡烛是 9 字段、数字是字符串：[ts,o,h,l,c,vol(张),volCcy(币),volCcyQuote,confirm]
    const okxRow = (tsMin, close, volCcy) => [
      String(tsMin * 60000), String(close), String(close + 10), String(close - 10), String(close),
      String(volCcy * 100), String(volCcy), '150', '0'
    ];
    const S15 = snap('15m'), S1H = snap('1h'), S4H = snap('4h'), S1D = snap('1d');
    const APP31 = fs.readFileSync(APP_JS, 'utf8');     // §30 块里的 APP_SRC 不在本作用域，单独读一份

    // ---- 31.1 抓取参数（OKX 大小写铁律）----
    const P = API.livePeriods ? API.livePeriods() : null;
    check('§31 只补 15m/1h/4h（1d 由 4h 派生，不直接抓）',
      Array.isArray(P) && P.join(',') === '15m,1h,4h', P && P.join(','));
    check('§31 OKX bar 参数大写 1H/4H（写小写会 51000 Parameter bar error）',
      API.liveUrl('1h').indexOf('bar=1H') >= 0 && API.liveUrl('4h').indexOf('bar=4H') >= 0 && API.liveUrl('15m').indexOf('bar=15m') >= 0,
      API.liveUrl('1h'));
    check('§31 URL 带 instId 与 limit', /instId=BTC-USDT-SWAP/.test(API.liveUrl('15m')) && /limit=\d+/.test(API.liveUrl('15m')));
    check('§31 刷新间隔 = 5 分钟', API.liveIntervalMs() === 300000, String(API.liveIntervalMs()));

    // ---- 31.2 解析：量能必须取 volCcy（第 7 列），不是 vol（第 6 列）----
    const parsed = API.liveParse([okxRow(29857245, 81324.1, 2419.0704)]);
    check('§31 解析取第 7 列 volCcy（币）而非第 6 列 vol（张）',
      parsed.length === 1 && near(parsed[0][5], 2419.0704, 1e-6), JSON.stringify(parsed[0]));
    check('§31 解析出的 ts 是「分钟」', parsed[0][0] === Math.floor(29857245 * 60000 / 60000));
    check('§31 解析结果按时间升序', (() => {
      const p = API.liveParse([okxRow(29857305, 1, 1), okxRow(29857245, 1, 1)]);
      return p.length === 2 && p[0][0] < p[1][0];
    })());
    check('§31 脏数据（空行/字段不足/非数字）被丢弃',
      API.liveParse([[], null, ['x'], ['1791473400000']]).length === 0);

    // ---- 31.3 合并：补齐 / 覆盖 ----
    const arr15 = DATA['15m'];
    const last15 = arr15[arr15.length - 1][0];
    const r1 = API.liveMerge('15m', [[last15 + 15, 1, 2, 0.5, 1.5, 7], [last15 + 30, 1, 2, 0.5, 1.5, 8]]);
    check('§31 补齐缺口：末尾追加 2 根', r1.added === 2 && arr15[arr15.length - 1][0] === last15 + 30, JSON.stringify(r1));
    const r2 = API.liveMerge('15m', [[last15 + 30, 9, 9, 9, 9, 9]]);
    check('§31 覆盖已存在的末根：不重复追加，值被更新',
      r2.added === 0 && r2.replaced === 1 && r2.minIdx === arr15.length - 1 &&
      arr15[arr15.length - 1][4] === 9 && arr15[arr15.length - 1][5] === 9, JSON.stringify(r2));
    check('§31 合并是幂等的（同一批再合一次无新增）',
      (() => { const r = API.liveMerge('15m', [[last15 + 30, 9, 9, 9, 9, 9]]); return r.added === 0; })());

    // ---- 31.4 1d 由 4h 重聚合（UTC 00:00 锚定，只覆盖最近几天）----
    {
      const h4last = DATA['4h'][DATA['4h'].length - 1][0];
      const nextDay = (Math.floor(h4last / 1440) + 1) * 1440;      // 下一个 UTC 零点
      API.liveMerge('4h', [
        [nextDay, 100, 120, 90, 110, 1],
        [nextDay + 240, 110, 150, 105, 140, 2],
        [nextDay + 480, 140, 145, 130, 135, 3],
        [nextDay + 720, 135, 160, 130, 155, 4]
      ]);
      const n = API.liveDeriveDaily();
      const d1 = DATA['1d'];
      const bar = d1[d1.length - 1];
      check('§31 1d 重聚合：新增当日，开高低收与 vol 汇总正确',
        n >= 1 && bar[0] === nextDay && bar[1] === 100 && bar[2] === 160 && bar[3] === 90 && bar[4] === 155 && near(bar[5], 10, 1e-9),
        JSON.stringify(bar));
      check('§31 1d 锚定 UTC 00:00（不是 OKX 原生的 16:00）', bar[0] % 1440 === 0);
    }

    restore(S15); restore(S1H); restore(S4H); restore(S1D);

    // ---- 31.5 端到端 tick：mock fetch ----
    // 主沙箱跑的是「复盘」实例（§30 起历史断言都按 review 的无前缀键名写的），
    // 所以这里显式把 §31 的开关掰到开，测完再掰回 null 让真实门控生效。
    API.liveSetEnabled(true);
    await API.setView('BTC', '15m');
    const base = { '15m': DATA['15m'].length, '1h': DATA['1h'].length, '4h': DATA['4h'].length };
    const storeKeys0 = Object.keys(store).join(',');
    const calls = [];
    let vc = 1000;
    API.liveSetFetch(async url => {
      calls.push(url);
      const rows = [];
      if (/bar=15m/.test(url)) {
        const t = DATA['15m'][DATA['15m'].length - 1][0];
        rows.push(okxRow(t + 15, vc++, 1.5), okxRow(t + 30, vc++, 1.6));
      } else if (/bar=1H/.test(url)) {
        const t = Math.floor((DATA['1h'][DATA['1h'].length - 1][0] + 60) / 60) * 60;
        rows.push(okxRow(t, vc++, 2.5));
      } else {
        const t = Math.floor((DATA['4h'][DATA['4h'].length - 1][0] + 240) / 240) * 240;
        rows.push(okxRow(t, vc++, 3.5));
      }
      return { ok: true, json: async () => ({ code: '0', msg: '', data: rows }) };
    });
    const st = await API.liveRefreshTick();
    check('§31 tick 拉了 3 个周期（15m/1H/4H）', calls.length === 3 && calls.every(u => /^https:\/\/www\.okx\.com\//.test(u)), calls.length + ' 次');
    check('§31 tick 成功 → 状态 ok 且带时间戳', st.ok === true && st.lastBarTs > 0, JSON.stringify(st));
    check('§31 tick 真的补了数据（三周期各 +1 以上）',
      DATA['15m'].length === base['15m'] + 2 && DATA['1h'].length === base['1h'] + 1 && DATA['4h'].length === base['4h'] + 1,
      JSON.stringify({ '15m': DATA['15m'].length, '1h': DATA['1h'].length, '4h': DATA['4h'].length }));
    check('§31 合并后当前周期数据源已重建（DS.len 跟着涨，len 不是快照）',
      API.dataLen() === DATA['15m'].length, API.dataLen() + ' vs ' + DATA['15m'].length);
    check('§31 自动补数不写 localStorage（不污染复盘进度）', Object.keys(store).join(',') === storeKeys0);

    // ---- 31.6 失败必须静默降级，不能抛错、不能改数据 ----
    const afterOk = { '15m': DATA['15m'].length, '1h': DATA['1h'].length, '4h': DATA['4h'].length };
    API.liveSetFetch(async () => { throw new Error('network down'); });
    const stNet = await API.liveRefreshTick();
    check('§31 fetch 抛异常 → 静默失败、状态离线', stNet.ok === false && /离线/.test(stNet.msg || ''), JSON.stringify(stNet));
    API.liveSetFetch(async () => ({ json: async () => ({ code: '51001', msg: 'bad param' }) }));
    const stCode = await API.liveRefreshTick();
    check('§31 OKX 返回非 0 code → 同样当失败', stCode.ok === false, JSON.stringify(stCode));
    check('§31 失败时一个字节都没改数据',
      DATA['15m'].length === afterOk['15m'] && DATA['1h'].length === afterOk['1h'] && DATA['4h'].length === afterOk['4h']);

    // ---- 31.7 只在「看盘」实例启用：复盘页必须一动不动 ----
    API.liveSetEnabled(null);                    // 掰回「按真实实例判定」
    check('§31 复盘实例不启用（APP_INSTANCE=review）', API.liveShouldRun() === false, String(API.liveShouldRun()));
    let hit = 0;
    API.liveSetFetch(async () => { hit++; return { json: async () => ({ code: '0', data: [] }) }; });
    await API.liveRefreshTick();
    check('§31 复盘实例下 tick 一个请求都不发', hit === 0, hit + ' 次');
    check('§31 App 静态检查：自动启动被 liveShouldRun() 包住',
      APP31.indexOf('if (liveShouldRun()) liveRefreshStart();') >= 0);
    check('§31 App 静态检查：切回前台立刻补一次（visibilitychange）',
      APP31.indexOf("document.addEventListener('visibilitychange'") >= 0);
    check('§31 App 静态检查：量能列注明取 volCcy 而不是 vol',
      /volCcy/.test(APP31) && /第\s*7\s*列|索引\s*6|\[6\]/.test(APP31));

    restore(S15); restore(S1H); restore(S4H); restore(S1D);
  }

  // ============ §32 自选看盘 MVP（多币种 + WebSocket 实时）============
  {
    const APP32 = fs.readFileSync(APP_JS, 'utf8');
    const ENTRY32 = path.join(__dirname, '..', 'watch', 'index.html');
    const WATCH_HTML = fs.existsSync(ENTRY32) ? fs.readFileSync(ENTRY32, 'utf8') : '';

    // ---- 32.1 自选配置与取数参数 ----
    check('§32 自选列表默认 BTC + ETH',
      Array.isArray(API.watchList()) && API.watchList().join(',') === 'BTC,ETH',
      (API.watchList() || []).join(','));
    check('§32 标的 → OKX instId 映射',
      API.watchInstOf('BTC') === 'BTC-USDT-SWAP' && API.watchInstOf('ETH') === 'ETH-USDT-SWAP');
    check('§32 REST 兜底 URL 走 www.okx.com 且带 instId + limit', (() => {
      const u = API.watchRestUrl('15m', 'ETH-USDT-SWAP');
      return /^https:\/\/www\.okx\.com\//.test(u) && /instId=ETH-USDT-SWAP/.test(u) && /limit=\d+/.test(u);
    })(), API.watchRestUrl('15m', 'ETH-USDT-SWAP'));
    check('§32 REST 兜底 bar 大小写铁律（1H/4H 大写、15m 小写）',
      /bar=1H/.test(API.watchRestUrl('1h', 'ETH-USDT-SWAP')) &&
      /bar=4H/.test(API.watchRestUrl('4h', 'ETH-USDT-SWAP')) &&
      /bar=15m/.test(API.watchRestUrl('15m', 'ETH-USDT-SWAP')));

    // ---- 32.2 数据装载：ETH 从无到有 ----
    check('§32 装载前 ETH 不在 SYMBOLS 里', !API.getSymbols().ETH);
    const put = API.watchPutSymbol('ETH', '15m', [[1000, 10, 12, 9, 11, 5], [1015, 11, 13, 10, 12, 6]]);
    check('§32 watchPutSymbol 建出 SYMBOLS.ETH（四周期 map 齐全）',
      !!API.getSymbols().ETH && put.added === 2 && ['15m', '1h', '4h', '1d'].every(p => !!API.getSymbols().ETH.map[p]),
      JSON.stringify(put));
    check('§32 写入的 15m 根数与顺序正确', (() => {
      const a = API.getSymbols().ETH.data['15m'];
      return a.length === 2 && a[0][0] < a[1][0];
    })());

    // ---- 32.3 合并：追加 / 覆盖 / 幂等 / 不串台 ----
    const m1 = API.watchMergeInto('ETH', '15m', [[1030, 12, 14, 11, 13, 7]]);
    check('§32 合并追加新根', m1.added === 1 && API.getSymbols().ETH.data['15m'].length === 3, JSON.stringify(m1));
    const m2 = API.watchMergeInto('ETH', '15m', [[1030, 12, 14, 11, 99, 8]]);
    check('§32 覆盖已存在末根（不重复追加、值被更新）',
      m2.added === 0 && m2.replaced === 1 && API.getSymbols().ETH.data['15m'].slice(-1)[0][4] === 99, JSON.stringify(m2));
    check('§32 合并幂等（同批再合无新增）', API.watchMergeInto('ETH', '15m', [[1030, 12, 14, 11, 99, 8]]).added === 0);
    check('§32 合并 ETH 不污染 BTC 数据',
      DATA['15m'].length > 240000 && !API.getSymbols().BTC.data['15m'].includes(99));

    // ---- 32.4 1d 由 4h 重聚合（UTC 00:00 锚定）----
    {
      const day = 29857245 - (29857245 % 1440);   // 某个 UTC 零点（分钟）
      API.watchPutSymbol('ETH', '4h', [
        [day, 100, 120, 90, 110, 1],
        [day + 240, 110, 150, 105, 140, 2],
        [day + 480, 140, 145, 130, 135, 3],
        [day + 720, 135, 160, 130, 155, 4]
      ]);
      API.watchDeriveDaily('ETH');
      const bar = API.getSymbols().ETH.data['1d'].slice(-1)[0];
      check('§32 ETH 1d 重聚合：OHLC 与 vol 汇总正确',
        !!bar && bar[0] === day && bar[1] === 100 && bar[2] === 160 && bar[3] === 90 && bar[4] === 155 && near(bar[5], 10),
        JSON.stringify(bar));
      check('§32 ETH 1d 锚定 UTC 00:00（不是 OKX 原生 16:00）', !!bar && bar[0] % 1440 === 0, String(bar && bar[0]));
    }

    // ---- 32.5 WebSocket：订阅参数与消息路由 ----
    const args = API.watchWsArgs();
    check('§32 一条连接订阅 3 周期 × 2 币 = 6 条', Array.isArray(args) && args.length === 6, String(args && args.length));
    check('§32 channel 命名正确（candle15m / candle1H / candle4H）', (() => {
      const ch = args.map(a => a.channel).filter((v, i, arr) => arr.indexOf(v) === i).sort();
      return ch.join(',') === 'candle15m,candle1H,candle4H';
    })(), args.map(a => a.channel).join(','));
    check('§32 订阅覆盖 BTC 与 ETH 两个 instId',
      args.filter(a => a.instId === 'BTC-USDT-SWAP').length === 3 &&
      args.filter(a => a.instId === 'ETH-USDT-SWAP').length === 3);
    check('§32 订阅参数结构与 OKX 一致（channel + instId）',
      args.every(a => typeof a.channel === 'string' && typeof a.instId === 'string'));

    const btc15Before = API.getSymbols().BTC.data['15m'].length;
    const eth15Before = API.getSymbols().ETH.data['15m'].length;
    API.watchOnWsMessage({
      arg: { channel: 'candle15m', instId: 'ETH-USDT-SWAP' },
      data: [['1789000000000', '1', '2', '0.5', '1.5', '700', '7', '10', '0']]
    });
    check('§32 WS 推送落到对应标的+周期（ETH 15m +1）',
      API.getSymbols().ETH.data['15m'].length === eth15Before + 1);
    check('§32 WS 推送不污染其它标的（BTC 15m 不变）',
      API.getSymbols().BTC.data['15m'].length === btc15Before);
    check('§32 WS 推送的量能取第 7 列 volCcy 而非第 6 列 vol',
      near(API.getSymbols().ETH.data['15m'].slice(-1)[0][5], 7, 1e-9),
      JSON.stringify(API.getSymbols().ETH.data['15m'].slice(-1)[0]));

    const eth15 = API.getSymbols().ETH.data['15m'].length;
    let threw = false;
    try {
      API.watchOnWsMessage(null);
      API.watchOnWsMessage(undefined);
      API.watchOnWsMessage('not json');
      API.watchOnWsMessage('{"event":"subscribe","arg":{}}');
      API.watchOnWsMessage({ arg: { channel: 'candle15m', instId: 'DOGE-USDT-SWAP' }, data: [['1789000000000', '1', '1', '1', '1', '1', '1', '1', '0']] });
      API.watchOnWsMessage({ arg: { channel: 'candle15m', instId: 'ETH-USDT-SWAP' }, data: null });
    } catch (e) { threw = true; }
    check('§32 脏消息 / 未知标的 / 订阅确认 → 不抛错', threw === false);
    check('§32 脏消息不产生任何数据变更', API.getSymbols().ETH.data['15m'].length === eth15, String(eth15));

    // ---- 32.6 断线 fail-safe：显式离线 + REST 轮询兜底 ----
    API.watchSetEnabled(true);
    let wsMade1 = 0;
    API.watchSetWS(function () { wsMade1++; this.send = function () {}; this.close = function () {}; });
    const st0 = API.watchGetStatus();
    check('§32 初始未连接 → 状态显式为离线（绝不假装有数据）',
      st0.connected === false && /离线/.test(st0.msg || ''), JSON.stringify(st0));
    API.watchOnOpen();
    check('§32 WS 连上 → connected=true 且状态不再含离线',
      API.watchGetStatus().connected === true && !/离线/.test(API.watchGetStatus().msg || ''));
    check('§32 连上后停掉 REST 轮询兜底', API.watchPolling() === false);
    API.watchOnClose();
    const st1 = API.watchGetStatus();
    check('§32 断线 → connected=false 且立刻转为离线',
      st1.connected === false && /离线/.test(st1.msg || ''), JSON.stringify(st1));
    check('§32 断线后启动 REST 轮询兜底', API.watchPolling() === true);
    check('§32 轮询兜底间隔有下限（不暴力刷 OKX）', API.watchFallbackMs() >= 30000, String(API.watchFallbackMs()));
    API.watchDisconnect();
    check('§32 disconnect 后不再轮询', API.watchPolling() === false);

    // ---- 32.7 实例隔离：只有 watch 实例才启用 ----
    API.watchSetEnabled(null);
    check('§32 复盘实例（review）不启用自选看盘', API.watchShouldRun() === false, String(API.watchShouldRun()));
    let hit32 = 0, wsMade = 0;
    API.watchSetFetch(async () => { hit32++; return { json: async () => ({ code: '0', data: [] }) }; });
    API.watchSetWS(function () { wsMade++; this.send = function () {}; this.close = function () {}; });
    await API.watchInit();
    check('§32 复盘实例下 watchInit 一个 REST 请求都不发', hit32 === 0, hit32 + ' 次');
    check('§32 复盘实例下不建立 WebSocket 连接', wsMade === 0, wsMade + ' 个');
    check('§32 App 静态检查：自选启动被 watchShouldRun() 包住',
      /if \(watchShouldRun\(\)\) watchInit\(\);/.test(APP32));
    check('§32 App 静态检查：自选列表 DOM 只在 watch 实例创建',
      APP32.indexOf('function watchBuildSidebar') > 0 && APP32.includes('if (!watchShouldRun()) return;'));

    // ---- 32.8 存储命名空间 ----
    check('§32 自选列表键走 STORAGE_NS 前缀（watch 实例 → watch__）',
      APP32.includes("STORAGE_NS + 'kline_watchlist_v1'"));
    check('§32 没有遗留的裸键名引用',
      new RegExp("(?<!STORAGE_NS \\+ )[\"']kline_watchlist_v1[\"']").test(APP32) === false);

    // ---- 32.9 构建产物：watch/index.html 由 index.html 派生 ----
    check('§32 watch/index.html 存在', WATCH_HTML.length > 0, WATCH_HTML.length + ' 字节');
    check('§32 watch 入口标记 = watch', /__APP_INSTANCE__\s*=\s*'watch'/.test(WATCH_HTML));
    check('§32 watch 入口引用 ../share/（多一层目录）',
      /src="\.\.\/share\/app\.js"/.test(WATCH_HTML) && /src="\.\.\/share\/data\.js"/.test(WATCH_HTML));
    check('§32 watch 入口不含内联数据', !WATCH_HTML.includes('window.BTCFUT_DATA='));
    check('§32 watch 标题可区分（自选）', /<title>[^<]*自选[^<]*<\/title>/.test(WATCH_HTML));
    check('§32 watch 入口与 build_live.cjs 生成结果逐字节一致', (() => {
      try {
        const { buildEntry } = require(path.join(__dirname, '..', 'build_live.cjs'));
        const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
        return buildEntry(src, 'watch') === WATCH_HTML;
      } catch (e) { return false; }
    })());

    delete API.getSymbols().ETH;   // 复原：本组自造的数据不带出作用域
  }

  // ============ §33 ETH 全量历史（按 UTC 自然年分片）============
  // 分两层测：
  //   A. 数据层（纯 node 读盘）—— 分片文件本身对不对（结构 / 有序 / 网格 / 年份归属 / 跨年接缝）
  //   B. 运行层（走 app.js API）—— 加载器门控 / 幂等 / 失败显式化 / materialize 与 REST 增量的合并
  {
    const ETH_DIR = path.join(__dirname, '..', 'share', 'eth');
    const ETH_MF = path.join(ETH_DIR, 'manifest.js');
    const ETH_MF_TEST = path.join(__dirname, '..', 'share', 'eth', 'manifest.js');
    const W_ENTRY = path.join(__dirname, '..', 'watch', 'index.html');
    const L_ENTRY = path.join(__dirname, '..', 'live', 'index.html');
    const R_ENTRY = path.join(__dirname, '..', 'index.html');
    const PERIODS33 = ['15m', '1h', '4h', '1d'];
    const G33 = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
    const tMinOf = (y, mo, d, h, mi) => Math.floor(Date.UTC(y, mo - 1, d, h, mi) / 60000);
    const utcYearOf = t => new Date(t * 60000).getUTCFullYear();

    const built = fs.existsSync(ETH_MF_TEST);
    check('§33 share/eth/manifest.js 已构建', built,
      built ? fs.statSync(ETH_MF_TEST).size + ' 字节' : '缺失 —— 先跑 node build_eth_shards.cjs && node update_eth_data.cjs');

    if (built) {
      const mtxt = fs.readFileSync(ETH_MF_TEST, 'utf8');
      const mm = /window\.ETHFUT_MANIFEST\s*=\s*(\{[\s\S]*\})\s*;/.exec(mtxt);
      const emf = mm ? JSON.parse(mm[1]) : null;

      // ---- 33.1 manifest 契约 ----
      check('§33 manifest 可解析且字段齐全',
        !!emf && ['sym', 'inst', 'ctVal', 'src', 'first', 'last', 'years', 'counts', 'total', 'builtAt'].every(k => emf[k] !== undefined),
        emf ? Object.keys(emf).join(',') : 'parse fail');
      check('§33 manifest.sym / inst 正确', !!emf && emf.sym === 'ETH' && emf.inst === 'ETH-USDT-SWAP',
        emf ? emf.sym + ' / ' + emf.inst : '-');
      check('§33 数据源指向 kline-timemachine（不是已 404 的 k--data）',
        !!emf && /kline-timemachine/.test(emf.src) && !/k--data/.test(emf.src), emf && emf.src);
      check('§33 years 升序、无重复、≥7 年',
        !!emf && emf.years.length >= 7 && emf.years.every((y, i) => i === 0 || y > emf.years[i - 1]),
        emf ? emf.years.join(',') : '-');

      // ---- 33.2 分片逐片体检 ----
      const readShard = y => {
        const t = fs.readFileSync(path.join(ETH_DIR, y + '.js'), 'utf8');
        const m = new RegExp('window\\.ETHFUT_SHARDS\\[' + y + '\\]\\s*=\\s*(\\{[\\s\\S]*\\})\\s*;').exec(t);
        if (!m) throw new Error(y + '.js 解析失败');
        return JSON.parse(m[1]);
      };
      const cat = { '15m': [], '1h': [], '4h': [], '1d': [] };
      const miss = [], shapeBad = [], monoBad = [], gapBad = [], misBad = [], yearBad = [];
      const lastYearShard = {};
      for (const y of emf.years) {
        const f = path.join(ETH_DIR, y + '.js');
        if (!fs.existsSync(f)) { miss.push(y); continue; }
        let sh;
        try { sh = readShard(y); } catch (e) { shapeBad.push(y + ':parse'); continue; }
        lastYearShard[y] = sh;
        for (const p of PERIODS33) {
          const a = sh[p];
          if (!Array.isArray(a) || !a.length) { shapeBad.push(y + '/' + p + ':empty'); continue; }
          if (emf.counts[y] && emf.counts[y][p] !== a.length) shapeBad.push(y + '/' + p + ':count ' + a.length + '≠' + emf.counts[y][p]);
          for (let i = 1; i < a.length; i++) if (a[i][0] <= a[i - 1][0]) { monoBad.push(y + '/' + p); break; }
          for (let i = 1; i < a.length; i++) if (a[i][0] - a[i - 1][0] !== G33[p]) { gapBad.push(y + '/' + p); break; }
          if (p === '1d' && a.some(b => b[0] % 1440 !== 0)) misBad.push(y);
          if (a.some(b => utcYearOf(b[0]) !== y)) yearBad.push(y + '/' + p);
          cat[p] = cat[p].concat(a);
        }
      }
      check('§33 每个年份的分片文件都在', miss.length === 0, miss.join(','));
      check('§33 每片四周期非空、根数与 manifest.counts 自洽', shapeBad.length === 0, shapeBad.slice(0, 5).join(','));
      check('§33 每片每周期严格递增', monoBad.length === 0, monoBad.slice(0, 5).join(','));
      check('§33 每片每周期无网格缺口（相邻间隔恒 = step）', gapBad.length === 0, gapBad.slice(0, 5).join(','));
      check('§33 1d 全部锚定 UTC 00:00（不是 OKX 原生 16:00）', misBad.length === 0, misBad.join(','));
      check('§33 年份归属正确（不串年）', yearBad.length === 0, yearBad.slice(0, 5).join(','));

      // ---- 33.3 跨片 / 总量 ----
      const catTot = {};
      for (const p of PERIODS33) catTot[p] = cat[p].length;
      check('§33 拼接后总根数与 manifest.total 一致',
        PERIODS33.every(p => catTot[p] === emf.total[p]),
        JSON.stringify(catTot) + ' vs ' + JSON.stringify(emf.total));
      check('§33 15m 总量级（源 233,730 + OKX 尾部补齐）', catTot['15m'] >= 233730, String(catTot['15m']));
      check('§33 三周期比例自洽（15m:1h≈4 / :4h≈16 / :1d≈96）',
        Math.abs(catTot['15m'] / catTot['1h'] - 4) < 0.05 &&
        Math.abs(catTot['15m'] / catTot['4h'] - 16) < 0.3 &&
        Math.abs(catTot['15m'] / catTot['1d'] - 96) < 3,
        (catTot['15m'] / catTot['1h']).toFixed(3) + ' / ' + (catTot['15m'] / catTot['4h']).toFixed(2) + ' / ' + (catTot['15m'] / catTot['1d']).toFixed(2));
      check('§33 跨年无缝（上年末根 + step == 下年首根）', (() => {
        for (const p of PERIODS33) {
          const by = new Map();
          for (const b of cat[p]) { const y = utcYearOf(b[0]); if (!by.has(y)) by.set(y, []); by.get(y).push(b); }
          const ys = [...by.keys()].sort((a, b) => a - b);
          for (let i = 1; i < ys.length; i++) {
            const a = by.get(ys[i - 1]).slice(-1)[0][0], b = by.get(ys[i])[0][0];
            if (b - a !== G33[p]) return false;
          }
        }
        return true;
      })());
      check('§33 15m 首根 = 2019-11-27 07:45 UTC',
        cat['15m'][0][0] === tMinOf(2019, 11, 27, 7, 45), new Date(cat['15m'][0][0] * 60000).toISOString());
      check('§33 manifest.first / last 与数据首末根一致',
        Date.parse(emf.first) === cat['15m'][0][0] * 60000 &&
        Date.parse(emf.last) === cat['15m'][cat['15m'].length - 1][0] * 60000,
        emf.first + ' → ' + emf.last);
      check('§33 分片末端落后当前不超过 30 天（尾部补齐有效，不留历史空洞）',
        (Date.now() - new Date(emf.last).getTime()) < 30 * 86400000,
        Math.round((Date.now() - new Date(emf.last).getTime()) / 86400000) + ' 天');

      // ---- 33.4 重采样自洽（不依赖源文件：直接验 4h/1d 就是 15m 的聚合）----
      const y2026 = lastYearShard[emf.years[emf.years.length - 1]];
      const h15 = y2026['15m'];
      const agg = (bars) => [bars[0][0], bars[0][1],
        bars.reduce((m, x) => Math.max(m, x[2]), -Infinity),
        bars.reduce((m, x) => Math.min(m, x[3]), Infinity),
        bars[bars.length - 1][4], bars.reduce((s, x) => s + x[5], 0)];
      const same6 = (a, b) => a[0] === b[0] && [1, 2, 3, 4].every(i => Math.abs(a[i] - b[i]) < 1e-9) && Math.abs(a[5] - b[5]) < 1e-3;
      check('§33 4h 首根 == 前 16 根 15m 的聚合（O/C/极值/量和）', same6(agg(h15.slice(0, 16)), y2026['4h'][0]),
        JSON.stringify(agg(h15.slice(0, 16))) + ' vs ' + JSON.stringify(y2026['4h'][0]));
      check('§33 1h 首根 == 前 4 根 15m 的聚合', same6(agg(h15.slice(0, 4)), y2026['1h'][0]));
      check('§33 1d 首根 == 前 96 根 15m 的聚合', same6(agg(h15.slice(0, 96)), y2026['1d'][0]),
        JSON.stringify(y2026['1d'][0]));

      // ---- 33.5 量能口径守门（1d 滚动台阶，与 BTC 同一阈值）----
      const e1d = cat['1d'];
      let mxStep = 0;
      const VOL_WIN = 30;
      if (e1d.length > VOL_WIN * 2) {
        const P = new Float64Array(e1d.length + 1);
        for (let i = 0; i < e1d.length; i++) P[i + 1] = P[i] + (+e1d[i][5] || 0);
        for (let i = VOL_WIN; i < e1d.length - VOL_WIN; i++) {
          const before = (P[i] - P[i - VOL_WIN]) / VOL_WIN, after = (P[i + VOL_WIN] - P[i]) / VOL_WIN;
          if (before > 0 && after > 0 && after / before > mxStep) mxStep = after / before;
        }
      }
      check('§33 ETH 量能无 >20 倍台阶（口径事故守门）', mxStep < 20, '×' + mxStep.toFixed(2));

      // ================= B. 运行层（app.js §33）=================

      // ---- 33.6 门控：review / live 不启用 ----
      API.ethReset();
      API.watchSetEnabled(false); API.ethSetEnabled(undefined);
      check('§33 复盘实例下不启用 ETH 分片', API.ethShouldRun() === false);
      API.watchSetEnabled(true); API.ethSetEnabled(undefined);
      const keepMf = sandbox.window.ETHFUT_MANIFEST;
      sandbox.window.ETHFUT_MANIFEST = null;
      check('§33 watch 实例但无 manifest → 静默退回 §32（不报错）', API.ethShouldRun() === false);
      sandbox.window.ETHFUT_MANIFEST = emf;
      check('§33 watch 实例 + manifest → 启用', API.ethShouldRun() === true);

      // ---- 33.7 加载器：幂等 / 命中 / 失败显式化（用合成分片，不依赖真实数据）----
      const synthYearA = 2021, synthYearB = 2022;
      const tA = tMinOf(2021, 1, 1, 0, 0), tB = tMinOf(2022, 1, 1, 0, 0);
      const mkBars = (base, n, step) => { const o = []; for (let i = 0; i < n; i++) o.push([base + i * step, 100, 101, 99, 100.5, 10]); return o; };
      const mkShard = base => ({ '15m': mkBars(base, 4, 15), '1h': mkBars(base, 4, 60), '4h': mkBars(base, 4, 240), '1d': mkBars(base, 4, 1440) });
      const synth = { [synthYearA]: mkShard(tA), [synthYearB]: mkShard(tB) };
      const synthMf = { sym: 'ETH', inst: 'ETH-USDT-SWAP', ctVal: 0.1, src: 'test', first: '', last: '', years: [synthYearA, synthYearB], counts: {}, total: {}, builtAt: 'test' };

      sandbox.window.ETHFUT_MANIFEST = synthMf;
      sandbox.window.ETHFUT_SHARDS = {};
      API.ethReset();
      const calls = [];
      API.ethSetLoader(y => { calls.push(y); sandbox.window.ETHFUT_SHARDS[y] = synth[y]; return Promise.resolve(true); });
      check('§33 ethLoadYear 成功 → 记入已加载', (await API.ethLoadYear(synthYearB)) === true &&
        API.ethLoadedYears().join(',') === String(synthYearB), API.ethLoadedYears().join(','));
      check('§33 已加载年份不重复请求（幂等）',
        (await API.ethLoadYear(synthYearB)) === true && calls.length === 1, calls.join(','));
      check('§33 未加载年份出现在 pending 列表', API.ethPendingYears().join(',') === String(synthYearA), API.ethPendingYears().join(','));
      check('§33 进度文案显示加载中', /加载中/.test(API.ethProgressText()), API.ethProgressText());
      check('§33 进度 summary 数值自洽',
        API.ethProgress().total === 2 && API.ethProgress().loaded === 1 && API.ethProgress().pending === 1,
        JSON.stringify(API.ethProgress()));

      API.ethSetLoader(() => Promise.resolve(false));
      API.ethReset();
      check('§33 加载失败 → 记入失败且不静默当成成功', (await API.ethLoadYear(synthYearA)) === false &&
        API.ethFailedYears().join(',') === String(synthYearA), API.ethFailedYears().join(','));
      check('§33 失败年份显式出现在进度文案里（fail-safe：不假装有数据）',
        /加载失败/.test(API.ethProgressText()), API.ethProgressText());
      check('§33 失败年份不会一直重试（进 failed 后 pending 移除）',
        API.ethPendingYears().indexOf(synthYearA) < 0, API.ethPendingYears().join(','));

      API.ethReset();
      let staticHit = 0;
      sandbox.window.ETHFUT_SHARDS = { [synthYearA]: synth[synthYearA], [synthYearB]: synth[synthYearB] };
      API.ethSetLoader(() => { staticHit++; return Promise.resolve(true); });
      API.ethRegisterExisting();
      check('§33 已静态注入的分片直接登记，不再发起网络加载',
        API.ethLoadedYears().length === 2 && staticHit === 0, staticHit + ' 次');

      // ---- 33.8 materialize：装配 / 幂等 / 保留 REST 增量 / 不污染 BTC ----
      const btc15Before = API.getSymbols().BTC.data['15m'].length;
      API.ethRegisterExisting();
      API.ethMaterialize();
      const e15 = API.getSymbols().ETH.data['15m'];
      check('§33 materialize 把已加载年份装进 SYMBOLS.ETH',
        e15.length === 8 && ['1h', '4h', '1d'].every(p => API.getSymbols().ETH.data[p].length === 8), String(e15.length));
      check('§33 materialize 后 15m 严格递增', e15.every((b, i) => i === 0 || b[0] > e15[i - 1][0]));
      check('§33 materialize 不污染 BTC 数据', API.getSymbols().BTC.data['15m'].length === btc15Before);
      check('§33 materialize 幂等（重复调用长度不变）', (() => {
        API.ethMaterialize();
        return API.getSymbols().ETH.data['15m'].length === 8;
      })());
      const tailTs = e15[e15.length - 1][0] + 15;
      API.watchMergeInto('ETH', '15m', [[tailTs, 100, 105, 95, 102, 3]]);
      API.ethMaterialize();
      const e15b = API.getSymbols().ETH.data['15m'];
      check('§33 materialize 保留比片末端更新的 REST/WS 柱子（不被分片底座覆盖）',
        e15b.length === 9 && e15b[e15b.length - 1][0] === tailTs && e15b[e15b.length - 1][5] === 3,
        String(e15b.length) + ' 末根ts=' + e15b[e15b.length - 1][0]);

      // ---- 33.9 门控：entry 层不启动 ----
      API.ethReset();
      sandbox.window.ETHFUT_SHARDS = {};
      let bootHit = 0;
      API.ethSetLoader(() => { bootHit++; return Promise.resolve(true); });
      API.watchSetEnabled(false); API.ethSetEnabled(undefined);
      check('§33 复盘实例下 ethBootstrap 一个分片都不加载', (await API.ethBootstrap()) === 0 && bootHit === 0, bootHit + ' 次');
      const APP33 = fs.readFileSync(APP_JS, 'utf8');
      check('§33 App 静态检查：ETH 加载被 ethShouldRun() 门控在 watch 实例内',
        /function ethShouldRun\s*\(\)/.test(APP33) && /watchShouldRun\(\)/.test(APP33) && /ethShouldRun\(\)/.test(APP33));
      API.ethSetBase('OVERRIDE_ETH_BASE/');
      check('§33 分片基址可由入口自行推导（多入口深度不同也能正确拼 URL）',
        API.ethBaseUrl() === 'OVERRIDE_ETH_BASE/', API.ethBaseUrl());
      API.ethSetBase(null);

      // ---- 33.10 构建产物：只有 watch 入口引 ETH 分片 ----
      const W33 = fs.readFileSync(W_ENTRY, 'utf8');
      const L33 = fs.readFileSync(L_ENTRY, 'utf8');
      const R33 = fs.readFileSync(R_ENTRY, 'utf8');
      check('§33 watch 入口静态引用 ../share/eth/manifest.js',
        /<script src="\.\.\/share\/eth\/manifest\.js"><\/script>/.test(W33));
      check('§33 watch 入口只引 manifest（年份分片由 §33 渐进加载，不静态注入）',
        (W33.match(/share\/eth\//g) || []).length === 1, String((W33.match(/share\/eth\//g) || []).length));
      check('§33 复盘入口完全不含 share/eth 引用', !/share\/eth/.test(R33));
      check('§33 看盘入口完全不含 share/eth 引用', !/share\/eth/.test(L33));
      for (const [name, inst, have] of [['watch', 'watch', W33], ['live', 'live', L33]]) {
        check('§33 ' + name + '/index.html 与 build_live.cjs 生成结果逐字节一致', (() => {
          try {
            const { buildEntry } = require(path.join(__dirname, '..', 'build_live.cjs'));
            return buildEntry(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), inst) === have;
          } catch (e) { return false; }
        })());
      }

      // 复原现场：本组自造的 ETH 数据与钩子不带出作用域
      delete API.getSymbols().ETH;
      sandbox.window.ETHFUT_MANIFEST = keepMf === undefined ? null : keepMf;
      sandbox.window.ETHFUT_SHARDS = {};
      API.ethReset(); API.ethSetLoader(null); API.ethSetBase(null);
      API.ethSetEnabled(undefined); API.watchSetEnabled(null);
      check('§33 测试钩子已复原（不影响后续用例）', API.ethShouldRun() === false, String(API.ethShouldRun()));
    }
  }

  // ============ 汇总 ============

  // 摘要必须在 stdout 回调里再 exit：直接 console.log + process.exit 在 stdout 是管道/重定向时
  // 会丢掉缓冲区里最后几行（页面代码带 setInterval，不能靠等事件循环自己退出）。
  const summary = '\n======== 结果: ' + pass + ' PASS / ' + fail + ' FAIL ========\n' +
    (errors.length ? '失败项:\n  ' + errors.join('\n  ') + '\n' : '');
  process.stdout.write(summary, () => process.exit(fail ? 1 : 0));
})().catch(e => { console.error('测试执行异常:', e); process.exit(2); });

// ---------- §27 迷你 DOM ----------
// 只实现排序逻辑真正用到的那部分：children / classList / dataset / getBoundingClientRect / insertBefore。
// 真实 DOM 里 children 是 HTMLCollection、rect 来自布局，这里用数组 + 手写坐标替代，行为等价。
function mkEl(cls, key, top, h) {
  const el = {
    id: '', dataset: {}, children: [], parentElement: null,
    classList: {
      _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    getBoundingClientRect() { return { top, bottom: top + h, height: h, left: 0, right: 100, width: 100 }; },
    appendChild(n) { if (n.parentElement) n.parentElement.removeChild(n); n.parentElement = this; this.children.push(n); return n; },
    insertBefore(n, ref) {
      if (n.parentElement) n.parentElement.removeChild(n);
      n.parentElement = this;
      const i = ref ? this.children.indexOf(ref) : this.children.length;
      this.children.splice(i < 0 ? this.children.length : i, 0, n);
      return n;
    },
    removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.parentElement = null; return n; },
    contains(n) { let p = n; while (p) { if (p === this) return true; p = p.parentElement; } return false; },
    querySelector(sel) {
      if (sel !== '.group.tools') return null;
      return this.children.find(c => c.classList.contains('group') && c.classList.contains('tools')) || null;
    }
  };
  if (cls) cls.split(' ').forEach(c => el.classList.add(c));
  if (key) {
    if (key[0] === '#') el.id = key.slice(1);
    else if (key.indexOf('tool:') === 0) el.dataset.tool = key.slice(5);
    else el.dataset.key = key;
  }
  return el;
}
function mkBar() {
  const root = mkEl('', '#toolbar', 0, 0);
  const groups = ['symbols', 'periods', 'ma', 'tools', 'axis', 'view', 'memory', 'focus', 'trades', 'sim'];
  const clsOf = { symbols: 'group symbols', periods: 'group periods', tools: 'group tools', focus: 'group focus-group', sim: 'group sim-group' };
  const title = mkEl('title', 'title', 0, 20);
  root.appendChild(title);
  let y = 30;
  for (const k of groups) { root.appendChild(mkEl(clsOf[k] || 'group', k, y, 80)); y += 100; }
  const T = root.querySelector('.group.tools');
  let ty = 0;
  for (const [key, tag] of [['tool:cursor', 'button'], ['tool:hline', 'button'], ['#clearLines', 'button'],
                            ['#tradeEnter', 'button'], ['#tradeDirSeg', 'div'], ['cont', 'label']]) {
    T.appendChild(mkEl('', key, ty, 30)); ty += 36;
  }
  return root;
}

// ---------- §28 真 DOM：jsdom（可选依赖，装不上就跳过 §28） ----------
function loadJsdom() {
  const cands = ['jsdom', '/Users/mac/.workbuddy/binaries/node/workspace/node_modules/jsdom'];
  for (const c of cands) { try { return require(c); } catch (e) {} }
  return {};
}

// ---------- 辅助 ----------
function deleteLine(type, obj) {
  // 按对象真实坐标点击命中并选中，再 Del 删除
  let px, py;
  if (type === 'hline' || type === 'supply' || type === 'demand') { px = 8 + 400; py = sy(obj.price); }
  else if (type === 'hchannel') { px = 8 + 400; py = sy(obj.price1); }
  else if (type === 'trade') { px = 600; py = sy(obj.entry); }
  else { px = sx(API.lnIdx(obj, 'x1')); py = sy(obj.y1); }
  down(px, py);
  const sel = API.getSelected() === obj;
  up(); // 释放拖拽，避免 dragTarget 残留
  key('Delete');
  return sel && !API.getLines().includes(obj);
}
function clearLines() {
  // 触发 清除画线 逻辑（含按标的存储的画线）
  API.clearLines && API.clearLines();
  for (const k in store) if (k.startsWith('kline_')) delete store[k];
  return true;
}
function resetSession() {
  try { delete store['kline_session_v1']; } catch (e) {}
  return true;
}
