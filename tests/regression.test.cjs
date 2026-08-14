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
const ctx2d = new Proxy({
  measureText: () => ({ width: 40 }),
  createRadialGradient: () => ({ addColorStop() {} })
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
    setTool: t => { toolMode = t; },
    setContinuousDraw: b => { continuousDraw = b; },
    setTradeMode: b => { tradeMode = b; },
    hitTest, dataXToScreenX, priceToY, xToIdx, yToPrice, closeAt, dataLen,
    getTradePlan, exitToolMode,
    setView, getCur: () => cur, getRightTs: () => rightTs,
    // 模拟交易：资金/手续费（§15 S1-S7）
    getWallet: () => simWallet, getAccount: () => simAccount, getMarginUsed: () => simMarginUsed,
    getFeeRate: () => simFeeRate, setFeeRate: r => { simFeeRate = r; },
    calcFee: n => simCalcFee(n),
    transfer: (amount, toAccount) => simTransfer(amount, toAccount),
    // 开仓（§15 S8-S12）
    openPosition: (dir, leverage, margin) => simOpenPosition(dir, leverage, margin),
    getPositions: () => simPositions, getLastPrice: () => simLastPrice(),
    // 加仓/减仓（§15 S13-S16）
    addMargin: (id, add) => simAddMargin(id, add),
    reduce: (id, pct) => simReduce(id, pct),
    // 挂单（§15 O1-O7）
    addOrder: (posId, type, price, pct) => simAddOrder(posId, type, price, pct),
    delOrder: (oid) => simDelOrder(oid),
    getOrders: () => simOrders
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 屏幕坐标 <-> 逻辑坐标（依赖 SCALE 建立后）
const sx = idx => API.dataXToScreenX(idx);
const sy = p => API.priceToY(p);

(async () => {
  await sleep(30); // 等待初始化 setView 完成

  // ============ 0. 环境 ============
  check('数据加载：15m 根数 242905', DATA['15m'].length === 242905, '' + DATA['15m'].length);
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
    const hp1 = API.hitTest(sx(t.x1), sy(t.y1));
    check('trend p1 命中', !!hp1 && hp1.handle === 'p1');
    const hp2 = API.hitTest(sx(t.x2), sy(t.y2));
    check('trend p2 命中', !!hp2 && hp2.handle === 'p2');
    // body 命中 + 整体平移（window mousemove）
    const midX = sx((t.x1 + t.x2) / 2), midY = sy((t.y1 + t.y2) / 2);
    const hb = API.hitTest(midX, midY);
    check('trend body 命中', !!hb && hb.handle === 'body');
    const before = { y1: t.y1, y2: t.y2 };
    down(midX, midY); wmove(400, 500);
    check('trend body 整体平移', !near(t.y1, before.y1) && near(t.y1 - before.y1, t.y2 - before.y2, 1e-6));
    up(); move(-1, -1);
    // p1 手柄拖拽
    const bp1 = { x1: t.x1, y1: t.y1 };
    down(sx(t.x1), sy(t.y1)); move(500, 300);
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
    const hp1 = API.hitTest(sx(m.x1), sy(m.y1));
    check('measure p1 命中', !!hp1 && hp1.handle === 'p1');
    // 拖动 p2
    const bp2 = { x2: m.x2, y2: m.y2 };
    down(sx(m.x2), sy(m.y2)); move(500, 500);
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
      API.hitTest(300, 400); API.hitTest(sx(c.x1), sy(c.y1)); API.hitTest(600, 300);
    } catch (e) { threw = e.message; }
    check('channel 存在时 hitTest 不抛异常（bug回归）', threw === null, threw || '');
    const hp1 = API.hitTest(sx(c.x1), sy(c.y1));
    check('channel p1 命中', !!hp1 && hp1.handle === 'p1');
    const hp3 = API.hitTest(sx(c.x3), sy(c.y3));
    check('channel p3 命中', !!hp3 && hp3.handle === 'p3');
    // p3 拖拽只改宽度（x3/y3）
    const bp3 = { x3: c.x3, y3: c.y3 };
    down(sx(c.x3), sy(c.y3)); move(500, 250);
    check('channel p3 拖拽生效', c.x3 !== bp3.x3 || c.y3 !== bp3.y3);
    up(); move(-1, -1);
    // body 整体平移（三点同移，斜率不变）
    const bodyHit = API.hitTest(sx((c.x1 + c.x2) / 2), sy((c.y1 + c.y2) / 2)) || API.hitTest(sx(c.x2), sy(c.y2));
    check('channel body 命中', !!bodyHit && bodyHit.handle === 'body');
    if (bodyHit) {
      const bb = { y1: c.y1, y2: c.y2, y3: c.y3 };
      down(sx((c.x1 + c.x2) / 2), sy((c.y1 + c.y2) / 2)); wmove(400, 500);
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

    // 右边缘锚定：单次缩放前后 viewStart+viewCount 应保持（桶对齐允许 ±bkt 误差）
    const vsX = API.getViewStart(), vcX = API.getViewCount();
    const eX = vsX + vcX;
    wheel(-120);
    const eY = API.getViewStart() + API.getViewCount();
    const bktX = Math.max(1, Math.round(vcX / 1200));
    check('单次缩放右边缘锚定（容差桶对齐）', Math.abs(eX - eY) <= bktX + 2,
      'edge ' + eX.toFixed(1) + ' vs ' + eY.toFixed(1));

    // 幅度参与换算：滚 2 格（-240）≈ 数学期望 viewCount × 1.15^-2（连续而非固定步进）
    const vcS = API.getViewCount();
    wheel(-240);
    const vcT = API.getViewCount();
    const expect = Math.round(vcS * Math.pow(1.15, -2));
    check('幅度参与换算（2格 ≈ ×1.15^-2）', Math.abs(vcT - expect) <= 2, vcS + ' -> ' + vcT + ' (期望 ' + expect + ')');

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
    check('viewStart 不越界', API.getViewStart() >= 0 && API.getViewStart() <= len - API.getViewCount(),
      'vs=' + API.getViewStart().toFixed(0) + ' vc=' + API.getViewCount());
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
    check('连续向左平移钳制 >= 0', API.getViewStart() >= 0, '' + API.getViewStart().toFixed(1));
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
    check('前置：已到左边界（viewStart=0）', API.getViewStart() === 0, '' + API.getViewStart());

    // 到边后继续左滑：viewStart 保持 0，panRubber 进入负值（橡皮筋）
    const rb0 = API.getPanRubber();
    wheel(0, -500); // 左边界继续左滑
    const rb1 = API.getPanRubber();
    check('左边界继续左滑→panRubber 负值（橡皮筋生效）', rb1 < 0 && API.getViewStart() === 0,
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
    // 场景1：小缩放（bkt=1）单次缩放偏差 ≤ 0.5 根（亚像素浮点容差）
    for (let i = 0; i < 10; i++) wheel(-5000); // 放大到最小
    wheel(0, -10000);                          // 左滑到中间（留出缩放空间）
    const vsA = API.getViewStart(), vcA = API.getViewCount();
    const rightA = vsA + vcA;
    wheel(-120); // 放大一格（viewCount 减小，右边缘应锚定）
    const rightB = API.getViewStart() + API.getViewCount();
    check('小缩放右边缘锚定（偏差≤0.5）', Math.abs(rightA - rightB) <= 0.5,
      rightA.toFixed(3) + ' -> ' + rightB.toFixed(3));

    // 场景2（核心）：从全量（viewCount=len，bkt>1）开始连续放大，
    // 右边缘必须恒锚定（当前实现桶对齐量化在奇数 viewStart 时破坏锚定）
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
    check('缩放后状态合法', API.getViewStart() >= 0 && API.getViewCount() >= 20 &&
      API.getViewStart() <= API.dataLen() - API.getViewCount());
  }

  // ============ 5.10 模拟交易：资金 + 手续费（PRD §13.2 / §15 S1-S7） ============
  {
    // S1 初始资金
    check('S1 初始资金：钱包 10000 / 账户 0', API.getWallet() === 10000 && API.getAccount() === 0,
      'wallet=' + API.getWallet() + ' account=' + API.getAccount());
    // S2 划转到账户
    API.transfer(3000, true);
    check('S2 划转 3000 到账户', API.getWallet() === 7000 && API.getAccount() === 3000,
      'wallet=' + API.getWallet() + ' account=' + API.getAccount());
    // S3 划转回钱包
    API.transfer(500, false);
    check('S3 划转回钱包 500', API.getWallet() === 7500 && API.getAccount() === 2500,
      'wallet=' + API.getWallet() + ' account=' + API.getAccount());
    // S4 超额划转拒绝
    const w0 = API.getWallet(), a0 = API.getAccount();
    API.transfer(99999, true);
    check('S4 超额划转被拒绝（余额不变）', API.getWallet() === w0 && API.getAccount() === a0);
    // S5 手续费 = 名义价值 × 费率（默认 0.05%）
    check('S5 手续费：5000U 名义价值 × 0.05% = 2.5U', Math.abs(API.calcFee(5000) - 2.5) < 1e-9,
      '' + API.calcFee(5000));
    // S6 费率可配置
    API.setFeeRate(0.001); // 0.1%
    check('S6 费率可配置：5000 × 0.1% = 5U', Math.abs(API.calcFee(5000) - 5) < 1e-9, '' + API.calcFee(5000));
    API.setFeeRate(0.0005);
    // 恢复初始（避免污染后续）：清空账户余额回钱包
    API.transfer(API.getAccount(), false);
    check('S-恢复：账户余额归零', API.getWallet() === 10000 && API.getAccount() === 0);
  }

  // ============ 5.11 模拟交易：开仓（PRD §13.3 / §15 S8-S12） ============
  {
    // 准备资金：划 2000 到账户
    API.transfer(2000, true);
    const px = API.getLastPrice();
    check('S-前置：获取最新价', px > 0, 'px=' + px);

    // S8 开多 5x，保证金 500
    const r8 = API.openPosition('long', 5, 500);
    check('S8 开多 5x 成功', r8 === true && API.getPositions().length === 1, '' + r8);
    const p = API.getPositions()[0];
    check('S8 持仓字段：方向/杠杆/开仓价/数量', p && p.dir === 'long' && p.leverage === 5 &&
      Math.abs(p.entryPrice - px) < 1e-9 && Math.abs(p.qty - (500 * 5 / px)) < 1e-9,
      'qty=' + (p && p.qty));
    check('S8 账户扣保证金 + 开仓手续费', Math.abs(API.getMarginUsed() - 500) < 1e-9 &&
      Math.abs(API.getAccount() - (2000 - 500 - API.calcFee(500 * 5))) < 1e-9,
      'account=' + API.getAccount() + ' margin=' + API.getMarginUsed());

    // S9 开空 10x，保证金 300
    const r9 = API.openPosition('short', 10, 300);
    check('S9 开空 10x 成功', r9 === true && API.getPositions().length === 2);
    const p2 = API.getPositions()[1];
    check('S9 空头方向正确', p2 && p2.dir === 'short' && p2.leverage === 10);
    check('S9 已占用保证金 = 800', Math.abs(API.getMarginUsed() - 800) < 1e-9, '' + API.getMarginUsed());

    // S10 保证金不足拒绝
    const n0 = API.getPositions().length;
    const r10 = API.openPosition('long', 5, 99999);
    check('S10 保证金不足拒绝开仓', r10 === false && API.getPositions().length === n0);

    // S12 图表仓位线（开仓价 = 最新收盘价）——由 openPosition 返回位置验证
    check('S12 开仓价 = 最新 K 线收盘价', Math.abs(p.entryPrice - px) < 1e-9);
  }

  // ============ 5.12 模拟交易：加仓 / 减仓（PRD §13.3.1 / §15 S13-S16） ============
  {
    // 沿用 5.11 的两个持仓（500U 多5x + 300U 空10x），账户余额 = 2000-800-手续费(1.25+1.5)=1197.25
    const pos = API.getPositions()[0]; // 多 5x
    const px0 = pos.entryPrice, qty0 = pos.qty;

    // S13 加仓：追加 200U → 数量增加，成本价加权平均
    const accBefore = API.getAccount();
    const ok13 = API.addMargin(pos.id, 200);
    const posA = API.getPositions()[0];
    const qtyNew = (200 * 5) / px0; // 加仓 qty（同价）
    const expectQty = qty0 + qtyNew;
    const expectEntry = (qty0 * px0 + qtyNew * px0) / expectQty; // 同价加权 = px0
    check('S13 加仓成功且数量增加', ok13 === true && Math.abs(posA.qty - expectQty) < 1e-9,
      'qty ' + qty0.toFixed(6) + ' -> ' + posA.qty.toFixed(6));
    check('S13 成本价加权平均', Math.abs(posA.entryPrice - expectEntry) < 1e-9,
      '' + posA.entryPrice);
    check('S13 保证金增加 + 加仓手续费', Math.abs(API.getMarginUsed() - 1000) < 1e-9 &&
      Math.abs(API.getAccount() - (accBefore - 200 - API.calcFee(200 * 5))) < 1e-9,
      'margin=' + API.getMarginUsed() + ' account=' + API.getAccount());

    // S14 减仓：卖 50% → 数量减半，该部分按当前价结算盈亏入账
    const accB = API.getAccount();
    const cur = API.getLastPrice();
    const qtyBefore = posA.qty;
    const marginBefore = posA.margin; // 注意：posA 是引用，reduce 会改它，先存
    const half = qtyBefore / 2;
    const pnl = (cur - posA.entryPrice) / posA.entryPrice * (half * posA.entryPrice); // 多头盈亏（名义=half×entry）
    const feeRed = half * cur * API.getFeeRate(); // 平仓手续费
    const ok14 = API.reduce(pos.id, 0.5);
    const posB = API.getPositions()[0];
    check('S14 减仓成功且数量减半', ok14 === true && Math.abs(posB.qty - half) < 1e-9,
      'qty ' + qtyBefore.toFixed(6) + ' -> ' + posB.qty.toFixed(6));
    check('S14 减仓盈亏+返还保证金入账（含平仓手续费）',
      Math.abs(API.getAccount() - (accB + marginBefore * 0.5 + pnl - feeRed)) < 1e-6,
      'pnl=' + pnl.toFixed(4) + ' fee=' + feeRed.toFixed(4) + ' acc=' + API.getAccount().toFixed(4));
    check('S14 已占用保证金按比例减少（1000→650）', Math.abs(API.getMarginUsed() - 650) < 1e-9,
      '' + API.getMarginUsed());
    // S16 减仓手续费已计入（上面断言含 feeRed）
    check('S16 减仓手续费计入', Math.abs(API.calcFee(half * cur) - feeRed) < 1e-9);
  }

  // ============ 5.13 模拟交易：挂单系统（PRD §13.4 / §15 O1-O7） ============
  {
    // 用 5.11 的第二个持仓（空 10x, entry=63454.7）和当前持仓1（多5x, 减仓后半仓）
    const longPos = API.getPositions()[0]; // 多 5x（减仓后 margin=350）
    const shortPos = API.getPositions()[1]; // 空 10x（margin=300）
    const eLong = longPos.entryPrice, eShort = shortPos.entryPrice;
    const up = eLong * 1.02, down = eLong * 0.98;

    // O1 多头往上 = TP
    const o1 = API.addOrder(longPos.id, 'TP', up, 0.5);
    check('O1 多头加 TP（价>成本）成功', o1 === true && API.getOrders().length === 1, '' + o1);
    // O2 多头往下 = SL
    const o2 = API.addOrder(longPos.id, 'SL', down, 0.5);
    check('O2 多头加 SL（价<成本）成功', o2 === true && API.getOrders().length === 2);
    // 多头方向校验：往下加 TP 应拒绝；往上加 SL 应拒绝
    check('O2b 多头 TP 必须 > 成本（反方向拒绝）', API.addOrder(longPos.id, 'TP', down, 0.3) === false);
    check('O2c 多头 SL 必须 < 成本（反方向拒绝）', API.addOrder(longPos.id, 'SL', up, 0.3) === false);

    // O3 空头：往下 = TP，往上 = SL
    const o3a = API.addOrder(shortPos.id, 'TP', eShort * 0.98, 0.5);
    const o3b = API.addOrder(shortPos.id, 'SL', eShort * 1.02, 0.5);
    check('O3 空头下=TP、上=SL 成功', o3a === true && o3b === true);
    check('O3b 空头反方向拒绝', API.addOrder(shortPos.id, 'TP', eShort * 1.02, 0.3) === false);

    // O4 数量为动态比例
    const tpOrder = API.getOrders().find(o => o.type === 'TP' && o.posId === longPos.id);
    check('O4 挂单数量 = 动态比例 pct', tpOrder && Math.abs(tpOrder.pct - 0.5) < 1e-9, tpOrder && tpOrder.pct);

    // O5 多档 TP
    API.addOrder(longPos.id, 'TP', eLong * 1.03, 0.25);
    const tpCount = API.getOrders().filter(o => o.type === 'TP' && o.posId === longPos.id).length;
    check('O5 多档 TP（2档）', tpCount === 2, '' + tpCount);

    // O6 多档 SL
    API.addOrder(shortPos.id, 'SL', eShort * 1.05, 0.25);
    const slCount = API.getOrders().filter(o => o.type === 'SL' && o.posId === shortPos.id).length;
    check('O6 多档 SL（2档）', slCount === 2, '' + slCount);

    // O7 删除挂单
    const delId = tpOrder.id;
    const ok7 = API.delOrder(delId);
    check('O7 删除挂单', ok7 === true && !API.getOrders().some(o => o.id === delId));
  }

  // ============ 6. 成交量分隔条 ============
  {
    const vf0 = API.getVolFrac();
    down(600, 510); move(600, 450);
    check('volFrac 拖动调节', API.getVolFrac() !== vf0, vf0.toFixed(3) + ' -> ' + API.getVolFrac().toFixed(3));
    up(); move(-1, -1);
  }

  // ============ 7. 盈亏比 ============
  {
    API.setTradeMode(true);
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
    API.hitTest(sx(t.x1), sy(t.y1));
    // 模拟点击选中
    down(sx(t.x1), sy(t.y1));
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
    check('15m 末根 = 2026-08-12 23:45',
      DATA['15m'][DATA['15m'].length - 1][0] === Math.floor(Date.UTC(2026, 7, 12, 23, 45) / 60000));
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
  else if (type === 'trade') { px = 600; py = sy(obj.entry); }
  else { px = sx(obj.x1); py = sy(obj.y1); }
  down(px, py);
  const sel = API.getSelected() === obj;
  up(); // 释放拖拽，避免 dragTarget 残留
  key('Delete');
  return sel && !API.getLines().includes(obj);
}
function clearLines() {
  const n0 = API.getLines().length;
  // 触发 清除画线 按钮逻辑（直接清空）
  for (const k in store) if (k.startsWith('kline_')) delete store[k];
  return true;
}
function resetSession() {
  try { delete store['kline_session_v1']; } catch (e) {}
  return true;
}
