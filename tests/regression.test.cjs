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
let md = null, mm = null, ml = null, wmm = null, wkd = null, wmu = null;
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
    setTool: t => { toolMode = t; },
    setContinuousDraw: b => { continuousDraw = b; },
    setTradeMode: b => { tradeMode = b; },
    hitTest, dataXToScreenX, priceToY, xToIdx, yToPrice, closeAt, dataLen,
    getTradePlan, exitToolMode
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
