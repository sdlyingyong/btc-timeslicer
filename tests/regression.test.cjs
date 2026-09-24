// btc-timeslicer 回归测试：覆盖全部画线/交互/盈亏比/视图功能
// 运行: node tests/regression.test.cjs
// 无外部依赖，mock canvas/DOM，直接驱动页面事件回调验证行为
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(HTML, 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let code = scripts.filter(s => !s.startsWith('window.BTCFUT_DATA')).join('\n');
const DATA = JSON.parse(scripts.find(s => s.startsWith('window.BTCFUT_DATA')).match(/window\.BTCFUT_DATA=(\{.*?\});/s)[1]);

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
const ctx2d = new Proxy({
  measureText: () => ({ width: 40 }),
  createRadialGradient: () => ({ addColorStop() {} }),
  fillText: t => { ctxTexts.push(String(t)); }
}, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? (() => {}) : undefined), set: () => true });
const canvasMock = {
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
    setView, getCur: () => cur, getRightTs: () => rightTs,
    setViewRange: (vs, vc) => { viewStart = vs; viewCount = vc; },
    parseDateInput,
    // §19 模拟交易
    getSimStore: () => simStore,
    simOpen, simAdd, simExit, simEvaluatePosition, simReplay, simAvgEntry, simOpenSize, simActiveStop, simLiqPrice, simRealizedPnl, simUnrealized, simDir, simMargin,
    loadSim, saveSim, simKey, simClearAll: () => { simStore = {}; saveSim(); },
    simDropMemory: () => { simStore = {}; },
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

  // ============ 汇总 ============
  console.log('\n======== 结果: ' + pass + ' PASS / ' + fail + ' FAIL ========');
  if (errors.length) { console.log('失败项:\n  ' + errors.join('\n  ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('测试执行异常:', e); process.exit(2); });

// ---------- 辅助 ----------
function deleteLine(type, obj) {
  // 按对象真实坐标点击命中并选中，再 Del 删除
  let px, py;
  if (type === 'hline') { px = 8 + 400; py = sy(obj.price); }
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
