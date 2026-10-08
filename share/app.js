// =====================================================================
// §30 多入口实例隔离（复盘 / 看盘）
// 背景：两个入口都在 <user>.github.io 下 —— origin 只看「协议+域名」，不看路径，
//       所以两边**共享**同一份 localStorage / IndexedDB。不加前缀的话，
//       一边的画线/视图/模拟进度会把另一边直接覆盖。
// 做法：入口页注入 window.__APP_INSTANCE__（'review' | 'live'），
//       除 review 外一律加「实例名__」前缀（review 保持原键名 → 不丢已有进度）。
// =====================================================================
// ==== §30 INSTANCE NS BEGIN ====
const APP_INSTANCE = (typeof window !== 'undefined' && window.__APP_INSTANCE__)
  ? String(window.__APP_INSTANCE__) : 'review';
const STORAGE_NS = APP_INSTANCE === 'review' ? '' : APP_INSTANCE + '__';
// ==== §30 INSTANCE NS END ====


const SYMBOLS = {
  "BTC": { data: window.BTCFUT_DATA, map: {'1d':'1d','4h':'4h','1h':'1h','15m':'15m'} }
};
const PERIODS = [
  { p: '1d', label: '日线' }, { p: '4h', label: '4 小时' },
  { p: '1h', label: '1 小时' }, { p: '15m', label: '15 分' }
];
const PAD_L = 8, PAD_R = 62, PAD_T = 12, PAD_B = 52;   // §13：底部 padding 加大 20px，给光标时间留独立行（避免覆盖 VOL 区与时间轴日期）
const canvas = document.getElementById('chart');
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;
let bgGrad = null, bgGradW = 0, bgGradH = 0;   // 背景渐变缓存（仅在尺寸变化时重建）
let curSym = 'BTC', cur = '1d', viewStart = 0, viewCount = 0;
const hover = { x: -1, y: -1 };

// 画线状态
let toolMode = 'cursor';
let continuousDraw = false;
let lines = [];
let drawingTrend = null;
let drawingMeasure = null;
let drawingChannel = null;   // 价格通道草稿 {phase:1定A,2定B,3定C, x1,y1,x2,y2}
let drawingHChannel = null;  // 水平通道草稿 {price1, price2?}（两条水平线成区间带）
// §24 供应线/需求线：单点水平线，固定配色 + 名称标签（选中不变色，靠线宽/实线/手柄反馈）
const HLEVEL_STYLE = {
  supply: { color: '#2fbf71', label: '供应线' },   // 绿：上方供给 / 压力
  demand: { color: '#ef4d4d', label: '需求线' }    // 红：下方需求 / 支撑
};
// §25 水平通道配色：上线（高价）绿 = 供应，下线（低价）红 = 需求（与 §24 同色，单一来源）
const HCHANNEL_STYLE = {
  up: HLEVEL_STYLE.supply.color,
  dn: HLEVEL_STYLE.demand.color,
  fill: 'rgba(177,140,255,0.12)'
};
let selectedLine = null;
let dragTarget = null;
let keepCursorTime = false;   // 切换标的/周期时保留鼠标所在K线时间，不跳最新
let tradeMode = false;          // 盈亏比工具是否激活（激活时若无规划则按 入场→TP→SL 拖出）
let rrDraft = null;             // 拖动创建中的草稿 {phase: 1入场定,2拖TP,3拖SL, entry, idx}
const TCOL = { profit: '#e85d8a', risk: '#3ebd93', entry: '#5dade2', handle: '#4dd2ff' };

// ---------- 专注计时器（番茄工作法风格）----------
const FOCUS_KEY = STORAGE_NS + 'focus_timer';
const FOCUS_HISTORY_KEY = STORAGE_NS + 'focus_history';
let focusState = null;          // { running, startedAt, accumulated, lastRunTs }
let focusTimerId = null;

function focusLoad() {
  try {
    const raw = localStorage.getItem(FOCUS_KEY);
    focusState = raw ? JSON.parse(raw) : null;
  } catch (e) { focusState = null; }
  if (!focusState || typeof focusState.accumulated !== 'number') {
    focusState = { running: false, startedAt: null, accumulated: 0, lastRunTs: Date.now() };
  }
  // 跨关闭续接：若上次运行中，丢弃离线时长，从此刻起续接（关闭/后台期间不计时）
  if (focusState.running) focusState.lastRunTs = Date.now();
  focusSave();
}
function focusSave() {
  try { localStorage.setItem(FOCUS_KEY, JSON.stringify(focusState)); } catch (e) {}
}
function focusNow() {
  // 当前累计毫秒：后台/关闭期间一律不计；仅可见运行时加当前段余量
  if (!focusState) return 0;
  if (document.hidden) return focusState.accumulated;
  return focusState.running ? focusState.accumulated + Math.max(0, Date.now() - focusState.lastRunTs) : focusState.accumulated;
}
function focusTick() {
  // 可见时持续把活跃时间落账到 accumulated（后台/关闭期间不触发 tick，且 visible/load 会重置 lastRunTs）
  if (focusState && focusState.running && !document.hidden) {
    const now = Date.now();
    focusState.accumulated += Math.max(0, now - focusState.lastRunTs);
    focusState.lastRunTs = now;
  }
}
function focusFmt(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + p(m) + ':' + p(sec) : p(m) + ':' + p(sec);
}
function focusRefresh() {
  const disp = document.getElementById('focusDisp');
  const startBtn = document.getElementById('focusStart');
  const doneBtn = document.getElementById('focusDone');
  if (!disp) return;
  disp.textContent = focusFmt(focusNow());
  disp.classList.toggle('running', !!(focusState && focusState.running));
  if (startBtn) {
    startBtn.textContent = (focusState && focusState.running) ? '暂停' : '开始';
    startBtn.classList.toggle('active', !!(focusState && focusState.running));
  }
  if (doneBtn) doneBtn.disabled = !(focusState && focusNow() > 0);
}
function focusToggle() {
  if (!focusState) return;
  const now = Date.now();
  if (focusState.running) {
    focusState.accumulated += Math.max(0, now - focusState.lastRunTs);
    focusState.running = false;
    focusState.lastRunTs = now;
  } else {
    focusState.running = true;
    if (!focusState.startedAt) focusState.startedAt = now;
    focusState.lastRunTs = now;
  }
  focusSave();
  focusRefresh();
}
function focusDone() {
  if (!focusState || focusNow() <= 0) return;
  const endTs = Date.now();
  let ms = focusState.accumulated;
  if (focusState.running) ms += Math.max(0, endTs - focusState.lastRunTs);
  const rec = { start: focusState.startedAt || endTs, end: endTs, ms };
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem(FOCUS_HISTORY_KEY)) || []; } catch (e) {}
  hist.unshift(rec);
  if (hist.length > 200) hist = hist.slice(0, 200);
  try { localStorage.setItem(FOCUS_HISTORY_KEY, JSON.stringify(hist)); } catch (e) {}
  focusState = { running: false, startedAt: null, accumulated: 0, lastRunTs: endTs };
  focusSave();
  focusRefresh();
  if (document.getElementById('focusPanel').classList.contains('show')) focusRenderHistory();
}
function focusPanelToggle() {
  const p = document.getElementById('focusPanel');
  const open = p.classList.toggle('show');
  if (open) focusRenderHistory();
}
function focusClearHistory() {
  if (!confirm('确定清空全部专注历史记录？')) return;
  try { localStorage.removeItem(FOCUS_HISTORY_KEY); } catch (e) {}
  focusRenderHistory();
}
function focusHistFmt(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function focusRenderHistory() {
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem(FOCUS_HISTORY_KEY)) || []; } catch (e) {}
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const totalN = hist.length;
  const totalMs = hist.reduce((a, r) => a + (r.ms || 0), 0);
  const today = hist.filter(r => (r.end || 0) >= todayStart);
  const todayMs = today.reduce((a, r) => a + (r.ms || 0), 0);
  document.getElementById('fTotalN').textContent = totalN;
  document.getElementById('fTotalMs').textContent = focusFmt(totalMs);
  document.getElementById('fTodayN').textContent = today.length;
  document.getElementById('fTodayMs').textContent = focusFmt(todayMs);
  const list = document.getElementById('fList');
  if (!hist.length) {
    list.innerHTML = '<div class="f-empty">暂无记录，开始一轮专注吧</div>';
    return;
  }
  list.innerHTML = hist.slice(0, 50).map(r =>
    '<div class="f-item"><span>' + focusHistFmt(r.start || r.end) + '</span><b>' + focusFmt(r.ms || 0) + '</b></div>'
  ).join('');
}
function focusInit() {
  focusLoad();
  document.getElementById('focusStart').addEventListener('click', () => { focusToggle(); });
  document.getElementById('focusDone').addEventListener('click', () => { focusDone(); });
  document.getElementById('focusHistory').addEventListener('click', () => { focusPanelToggle(); });
  document.getElementById('focusClear').addEventListener('click', () => { focusClearHistory(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.getElementById('focusPanel').classList.remove('show');
  });
  document.addEventListener('visibilitychange', () => {
    if (!focusState) return;
    if (document.hidden) {
      // 切后台：把已运行时间落账，lastRunTs 固定，后台期间不计
      if (focusState.running) {
        focusState.accumulated += Math.max(0, Date.now() - focusState.lastRunTs);
        focusState.lastRunTs = Date.now();
        focusSave();
      }
    } else {
      // 切回：丢弃后台时长，从此刻续接
      if (focusState.running) {
        focusState.lastRunTs = Date.now();
        focusSave();
      }
      focusRefresh();
    }
  });
  window.addEventListener('beforeunload', () => {
    if (focusState && focusState.running) {
      focusState.accumulated += Math.max(0, Date.now() - focusState.lastRunTs);
      focusState.lastRunTs = Date.now();
      focusSave();
    }
  });
  focusTimerId = setInterval(() => { focusTick(); focusRefresh(); }, 250);
  focusRefresh();
}
// ---------- 专注计时器结束 ----------

// 数据源（内联 或 分块懒加载）
let DS = null;
let drawScheduled = false;
let volFrac = 0.22;   // 成交量副图占图表高度比例（可拖动调节）
let goToOpen = false;   // 日期跳转对话框打开标志（打开时屏蔽其它快捷键）

function dataLen() { return DS ? DS.len : 0; }
function getBar(i) { return DS ? DS.getBar(i) : null; }
function fmt(n) { return Number(n).toLocaleString('en-US'); }
function fmtPrice(p) { return p >= 1000 ? Number(p).toLocaleString('en-US', { maximumFractionDigits: 2 }) : Number(p).toFixed(2); }
// 时间戳兼容：数字=分钟epoch（紧凑单文件版）；字符串="YYYY-MM-DD HH:mm:ss"（多品种分块版）
function tsStr(v) {
  if (typeof v === 'number') {
    const d = new Date(v * 60000);
    const p = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':00';
  }
  return v;
}
function tsMin(v) {
  if (typeof v === 'number') return v;
  return new Date(v.replace(/-/g, '/')).getTime() / 60000;
}
let logScale = false;
// 视图偏好持久化（localStorage，跨会话记住习惯）
const PREFS_KEY = STORAGE_NS + 'kline_view_prefs_v1';
const PREFS = ['ema20', 'ema120', 'logscale', 'keepTime'];
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    for (const id of PREFS) {
      const el = document.getElementById(id);
      if (el && typeof p[id] === 'boolean') el.checked = p[id];
    }
    if (typeof p.volFrac === 'number') volFrac = Math.max(0.06, Math.min(0.6, p.volFrac));
  } catch (e) {}
}
function savePrefs() {
  try {
    const p = { volFrac: volFrac };
    for (const id of PREFS) { const el = document.getElementById(id); if (el) p[id] = el.checked; }
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch (e) {}
}
// ---------- 会话持久化：画线 + 浏览位置（按 标的|周期 分开记忆） ----------
const SESSION_KEY = STORAGE_NS + 'kline_session_v1';
let linesStore = {};          // 标的 -> 画线数组（X 以时间戳存储，跨周期共享显示）
let viewStore = {};           // "SYM|period" -> {viewStart, viewCount}  浏览位置（按周期独立记忆）
let RESTORE = null;           // 首次启动待恢复的 {sym,period,viewStart,viewCount}
let sessSaveTimer = null;
function sessionKey() { return curSym + '|' + cur; }   // 浏览位置：按 标的|周期 独立记忆
function lineKey() { return curSym; }                    // 画线：按 标的 共享（时间戳锚定，跨周期显示）
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && typeof s === 'object') {
      if (s.linesStore && typeof s.linesStore === 'object') linesStore = s.linesStore;
      if (s.viewStore && typeof s.viewStore === 'object') viewStore = s.viewStore;
      if (s.sym && SYMBOLS[s.sym] && s.period &&
          typeof s.viewStart === 'number' && typeof s.viewCount === 'number') {
        RESTORE = { sym: s.sym, period: s.period, viewStart: s.viewStart, viewCount: s.viewCount };
      }
    }
  } catch (e) {}
}
function saveSessionNow() {
  try {
    linesStore[lineKey()] = lines;
    viewStore[sessionKey()] = { viewStart: Math.floor(viewStart), viewCount: viewCount };
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      sym: curSym, period: cur,
      viewStart: Math.floor(viewStart), viewCount: viewCount,
      linesStore: linesStore, viewStore: viewStore
    }));
  } catch (e) {}
}
function scheduleSessionSave() {
  if (sessSaveTimer) clearTimeout(sessSaveTimer);
  sessSaveTimer = setTimeout(saveSessionNow, 500);
}
// 视图位置保存：仅在平移/缩放停止后才写（2s 防抖），避免高频操作反复序列化 20 币数据写 localStorage
let viewSaveTimer = null;
function scheduleViewSave() {
  if (viewSaveTimer) clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveSessionNow, 2000);
}

// ================= 交割单导入 / 开平仓标注 =================
let tradesBySym = {};        // 归一化币种 -> [{side, entryT, entryP, exitT, exitP, pnl, lev}]
let showTrades = true;
let resolvedMarks = [];      // 当前 sym|period 已解析的标注（bar 索引 + 价格）
const marksCache = {};
const TRADES_KEY = STORAGE_NS + 'kline_trades_v1';

// 把交割单里的 "BTC-USDT-SWAP" / "ETH-USDT" 等归一化成查看器币种键
function normSym(raw) {
  if (!raw) return null;
  let s = String(raw).toUpperCase().trim();
  if (/^(交易对|币种|SYMBOL|PAIR)$/.test(s)) return null;
  s = s.replace(/\s+(PERP|SWAP|LINEAR|INVERSE|QUARTER)$/, '');
  s = s.replace(/[-_]?(PERP|SWAP|LINEAR|INVERSE|QUARTER)$/, '');
  s = s.replace(/(USDT|USD|TUSD|USDC|BUSD|DAI|PAX|USDK|BTC|ETH|BNB)$/, '');
  return SYMBOLS[s] ? s : null;
}
function setTradeInfo(t) { const el = document.getElementById('tradeInfo'); if (el) el.textContent = t || ''; }

function loadTrades() {
  try {
    const raw = localStorage.getItem(TRADES_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') { tradesBySym = o; showTrades = true; }
  } catch (e) {}
}

// 解析 Excel：自动识别两个 sheet、按表头列名定位，归一化币种后按当前币种绘制
// ================= 模拟交易（§19）：持仓模型 + 盈亏数学 + 回放求值 =================
const SIM_KEY = STORAGE_NS + 'kline_sim_v1';
let simStore = {};   // { 'sym|period': { positions: Position[], log: OpLog[] } }

function simKey(sym, period) { return sym + '|' + period; }

function loadSim() {
  try {
    const raw = localStorage.getItem(SIM_KEY);
    simStore = raw ? JSON.parse(raw) : {};
  } catch (e) { simStore = {}; }
}
function saveSim() {
  try { localStorage.setItem(SIM_KEY, JSON.stringify(simStore)); } catch (e) {}
}

// ---- 纯函数：持仓数学（统一约定见 PRD §19.4.2）----
function simDir(pos) { return pos.side === 'long' ? 1 : -1; }
function simCommittedSize(pos) { return pos.legs.reduce((a, l) => a + (l.size || 0), 0); }
function simExitedSize(pos) { return pos.exits.reduce((a, x) => a + (x.size || 0), 0); }
function simOpenSize(pos) { return Math.max(0, simCommittedSize(pos) - simExitedSize(pos)); }
function simAvgEntry(pos) {
  const s = simCommittedSize(pos);
  if (s === 0) return 0;
  return pos.legs.reduce((a, l) => a + (l.price || 0) * (l.size || 0), 0) / s;
}
function simMargin(pos) { return simOpenSize(pos) / pos.leverage; }
function simActiveStop(pos) {
  const stops = pos.legs.map(l => l.stop).filter(s => s != null && !isNaN(s));
  if (!stops.length) return null;
  return pos.side === 'long' ? Math.min.apply(null, stops) : Math.max.apply(null, stops);
}
function simLiqPrice(pos) {
  const e = simAvgEntry(pos);
  return pos.side === 'long' ? e * (1 - 1 / pos.leverage) : e * (1 + 1 / pos.leverage);
}
function simRealizedPnl(pos) { return pos.exits.reduce((a, x) => a + (x.realized || 0), 0); }
function simUnrealized(pos, cursorPrice) {
  if (pos.status !== 'open') return 0;
  return simDir(pos) * (cursorPrice - simAvgEntry(pos)) * simOpenSize(pos);
}

// 开仓：在光标处建立多/空持仓（price = 光标价，ts = 光标 bar 时间戳）
function simOpen(o) {
  const sym = o.sym, period = o.period, side = o.side, leverage = o.leverage;
  const size = o.size, price = o.price, stop = (o.stop == null || isNaN(o.stop)) ? null : o.stop, ts = o.ts;
  const k = simKey(sym, period);
  simStore[k] = simStore[k] || { positions: [], log: [] };
  const st = simStore[k];
  const leg = { ts: ts, price: price, size: size, stop: stop };
  const pos = {
    id: 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    sym: sym, period: period, side: side, leverage: leverage,
    legs: [leg], exits: [], autoExit: null, status: 'open', realizedPnl: 0, openTs: ts
  };
  st.positions.push(pos);
  st.log.push({
    t: ts, action: 'open', side: side, leverage: leverage, price: price, size: size, stop: stop,
    sym: sym, period: period,
    msg: (side === 'long' ? '开多' : '开空') + '@' + price + ' lev=' + leverage + 'x size=' + size + (stop != null ? ' sl=' + stop : '')
  });
  saveSim();
  return pos;
}
function simClearAll() { simStore = {}; saveSim(); }

// 加仓：对当前同 sym|period 的未平持仓追加一条腿（带本腿止损），重算 avgEntry/openSize/activeStop
function simAdd(o) {
  const sym = o.sym, period = o.period, size = o.size, price = o.price;
  const stop = (o.stop == null || isNaN(o.stop)) ? null : o.stop, ts = o.ts;
  const k = simKey(sym, period);
  const st = simStore[k];
  if (!st) return null;
  const pos = st.positions.filter(p => p.status === 'open').pop(); // 当前未平持仓
  if (!pos) return null;
  pos.legs.push({ ts: ts, price: price, size: size, stop: stop });
  st.log.push({
    t: ts, action: 'add', side: pos.side, leverage: pos.leverage, price: price, size: size, stop: stop,
    sym: sym, period: period,
    msg: '加仓@' + price + ' size=' + size + (stop != null ? ' sl=' + stop : '')
  });
  saveSim();
  return pos;
}

// 平仓：平半(half)/平全(full)，以光标价结算已实现盈亏，记录退出腿与日志
function simExit(o) {
  const sym = o.sym, period = o.period, kind = o.kind, price = o.price, ts = o.ts;
  const k = simKey(sym, period); const st = simStore[k];
  if (!st) return null;
  const pos = st.positions.filter(p => p.status === 'open').pop();
  if (!pos) return null;
  const dir = simDir(pos), e = simAvgEntry(pos);
  const cur = simOpenSize(pos);
  const exitSize = kind === 'half' ? cur / 2 : cur;
  const realized = dir * (price - e) * exitSize;
  pos.exits.push({ ts: ts, price: price, size: exitSize, kind: kind, realized: realized });
  pos.realizedPnl += realized;
  if (kind === 'full' || simOpenSize(pos) <= 1e-12) pos.status = 'closed';
  st.log.push({
    t: ts, action: kind, side: pos.side, leverage: pos.leverage, price: price, size: exitSize,
    sym: sym, period: period, realized: realized,
    msg: (kind === 'half' ? '平半' : '平全') + '@' + price + ' size=' + exitSize + ' 实现PnL=' + realized.toFixed(2)
  });
  saveSim();
  return pos;
}

// 回放求值：对窗口 (openTs, cursorTs] 的 bars，判定止损/强平首触发（纯函数，便于单测）
function simEvaluatePosition(pos, bars) {
  const S = simActiveStop(pos);
  const liq = simLiqPrice(pos);
  const dir = simDir(pos);
  const e = simAvgEntry(pos);
  for (const b of bars) {
    let hit = null, price = null;
    if (pos.side === 'long') {
      if (S != null && b[3] <= S) { hit = 'sl'; price = S; }
      else if (b[3] <= liq) { hit = 'liq'; price = liq; }
    } else {
      if (S != null && b[2] >= S) { hit = 'sl'; price = S; }
      else if (b[2] >= liq) { hit = 'liq'; price = liq; }
    }
    if (hit) {
      const size = simOpenSize(pos);
      const realized = dir * (price - e) * size;
      const exit = { ts: b[0], price: price, size: size, kind: hit, auto: true, realized: realized };
      pos.exits.push(exit);
      pos.realizedPnl += realized;
      pos.status = 'closed';
      return exit;
    }
  }
  return null;
}

function simRecomputeStatus(pos) {
  pos.status = pos.exits.some(e => e.kind !== 'half') ? 'closed' : 'open';
}

// 回放：基于当前光标重算所有 open 持仓的止损/强平。每次从 (openTs,cursorTs] 重算，可逆。
function simReplay(sym, period, cursorTs) {
  const k = simKey(sym, period);
  const st = simStore[k];
  if (!st) return;
  const data = (window.BTCFUT_DATA && window.BTCFUT_DATA[period]) || [];
  for (const pos of st.positions) {
    // 先剥离上一轮自动退出（用户退出保留），重算 realized/status
    const userExits = pos.exits.filter(e => !e.auto);
    pos.exits = userExits;
    pos.realizedPnl = userExits.reduce((a, x) => a + (x.realized || 0), 0);
    simRecomputeStatus(pos);
    if (pos.status !== 'open') continue;        // 已被用户全平 → 不再回放
    if (cursorTs < pos.openTs) continue;        // 未来/未触发 → 不显示
    const bars = data.filter(b => b[0] > pos.openTs && b[0] <= cursorTs);
    simEvaluatePosition(pos, bars);
    if (!pos.exits.some(e => e.auto)) simRecomputeStatus(pos); // 未触发仍 open
  }
}

// ================= 模拟交易 UI（§19）：光标下单 + 渲染 + 面板 =================
// 当前「回放光标」= 鼠标所在 bar；无悬停时取视图最右可见根（时光机当前时间）
function simCursorIdx() {
  if (hover.x >= PAD_L && hover.x <= PAD_L + SCALE.plotW) {
    const i = Math.floor(SCALE.viewStart + (hover.x - PAD_L) / SCALE.xW);
    if (i >= 0 && i < dataLen()) return i;
  }
  return -1;
}
function simCursorBar() {
  const i = simCursorIdx();
  if (i >= 0) { const b = getBar(i); if (b) return b; }
  const r = Math.max(0, Math.min(dataLen() - 1, Math.floor(viewStart + viewCount) - 1));
  return getBar(r);
}
function simCursorTs() { const b = simCursorBar(); return b ? b[0] : null; }
function simCursorPrice() { const b = simCursorBar(); return b ? b[4] : null; } // close

// 读取 UI 控件（无控件/空值时给出默认），便于无 DOM 单测
function simLeverage() {
  const el = document.getElementById('simLev');
  const v = parseFloat(el && el.value);
  return (v === 5 || v === 10) ? v : 10;
}
function simStopVal() {
  const el = document.getElementById('simStop');
  const s = el && el.value;
  if (s === '' || s == null) return null;
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}
function simSizeVal() {
  const el = document.getElementById('simSize');
  const v = parseFloat(el && el.value);
  return (v && v > 0) ? v : 1;
}

// ---- 控制器：以「光标处」为基准开/加/平，opts 可显式覆盖（测试友好）----
function simOpenAtCursor(side, opts) {
  opts = opts || {};
  const sym = opts.sym || curSym, period = opts.period || cur;
  const price = opts.price != null ? opts.price : simCursorPrice();
  const ts = opts.ts != null ? opts.ts : simCursorTs();
  if (ts == null) return null;
  const pos = simOpen({ sym: sym, period: period, side,
    leverage: opts.leverage != null ? opts.leverage : simLeverage(),
    size: opts.size != null ? opts.size : simSizeVal(),
    price: price, stop: opts.stop !== undefined ? opts.stop : simStopVal(), ts });
  simReplay(sym, period, ts);
  renderSim(); draw();
  return pos;
}
function simAddAtCursor(opts) {
  opts = opts || {};
  const sym = opts.sym || curSym, period = opts.period || cur;
  const price = opts.price != null ? opts.price : simCursorPrice();
  const ts = opts.ts != null ? opts.ts : simCursorTs();
  if (ts == null) return null;
  const pos = simAdd({ sym: sym, period: period,
    size: opts.size != null ? opts.size : simSizeVal(),
    price: price, stop: opts.stop !== undefined ? opts.stop : simStopVal(), ts });
  if (pos) { simReplay(sym, period, ts); renderSim(); draw(); }
  return pos;
}
function simExitAtCursor(kind, opts) {
  opts = opts || {};
  const sym = opts.sym || curSym, period = opts.period || cur;
  const price = opts.price != null ? opts.price : simCursorPrice();
  const ts = opts.ts != null ? opts.ts : simCursorTs();
  if (ts == null) return null;
  const pos = simExit({ sym: sym, period: period, kind: kind, price: price, ts });
  if (pos) { simReplay(sym, period, ts); renderSim(); draw(); }
  return pos;
}
function simClearPositions() { simClearAll(); renderSim(); draw(); }

// 渲染数据（纯函数，供 drawSim 与面板共用）：每个持仓一条 mark
function simMarks(sym, period, cursorTs) {
  const st = simStore[simKey(sym, period)];
  if (!st) return [];
  let cursorPrice = null;
  if (cursorTs != null) {
    const ci = findIdxSync(cursorTs);
    const b = ci >= 0 ? getBar(ci) : null;
    cursorPrice = b ? b[4] : null;
  }
  const out = [];
  for (const pos of st.positions) {
    out.push({
      id: pos.id, side: pos.side, leverage: pos.leverage, status: pos.status,
      entryIdx: findIdxSync(pos.openTs), entryPrice: simAvgEntry(pos),
      size: simOpenSize(pos), committed: simCommittedSize(pos),
      sl: simActiveStop(pos), liq: simLiqPrice(pos),
      exits: pos.exits.map(e => ({ idx: findIdxSync(e.ts), price: e.price, kind: e.kind, auto: !!e.auto, realized: e.realized || 0 })),
      realized: simRealizedPnl(pos),
      unrealized: cursorPrice != null ? simUnrealized(pos, cursorPrice) : 0,
      margin: simOpenSize(pos) / pos.leverage
    });
  }
  return out;
}

// 在 K 线上绘制模拟持仓：SL 红虚线 / 强平橙虚线 / 入场点 / 退出点
function drawSim() {
  const marks = simMarks(curSym, cur, simCursorTs());
  if (!marks.length) return;
  const plotL = PAD_L, plotR = PAD_L + SCALE.plotW;
  ctx.save();
  ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'alphabetic';
  for (const m of marks) {
    if (m.sl != null) {
      const y = SCALE.yP(m.sl);
      if (y >= SCALE.mainTop - 30 && y <= SCALE.mainBot + 30) {
        ctx.strokeStyle = 'rgba(239,77,77,.75)'; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#ff9a9a'; ctx.textAlign = 'left'; ctx.fillText('SL ' + fmtPrice(m.sl), plotL + 4, y - 3);
      }
    }
    if (m.liq != null && m.liq > 0) {
      const y = SCALE.yP(m.liq);
      if (y >= SCALE.mainTop - 30 && y <= SCALE.mainBot + 30) {
        ctx.strokeStyle = 'rgba(255,154,61,.65)'; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#ffb454'; ctx.textAlign = 'left'; ctx.fillText('LIQ ' + fmtPrice(m.liq), plotL + 4, y + 11);
      }
    }
    if (m.entryIdx >= 0) {
      const ex = PAD_L + (m.entryIdx - SCALE.viewStart + 0.5) * SCALE.xW;
      if (ex >= plotL - 40 && ex <= plotR + 40) {
        const ey = SCALE.yP(m.entryPrice);
        const col = m.side === 'long' ? '#ef4d4d' : '#2fbf71';
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.fillText(m.side === 'long' ? '开多' : '开空', ex, ey - 7);
      }
    }
    for (const x of m.exits) {
      if (x.idx < 0) continue;
      const xx = PAD_L + (x.idx - SCALE.viewStart + 0.5) * SCALE.xW;
      if (xx < plotL - 40 || xx > plotR + 40) continue;
      const xy = SCALE.yP(x.price);
      const col = x.kind === 'sl' ? '#ff5d5d' : x.kind === 'liq' ? '#ffb454' : x.kind === 'half' ? '#4dd0ff' : '#9aa6bd';
      const label = x.kind === 'sl' ? '损' : x.kind === 'liq' ? '强平' : x.kind === 'half' ? '平半' : '平全';
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(xx, xy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.fillText(label, xx, xy + 13);
    }
  }
  ctx.restore();
}

// 浮动持仓面板（仅更新 #simBody，关闭按钮常驻不丢监听）
function renderSim() {
  const panel = document.getElementById('simPanel');
  if (!panel) return;
  const body = document.getElementById('simBody');
  if (!body) return;
  const marks = simMarks(curSym, cur, simCursorTs());
  if (!marks.length) { panel.style.display = 'none'; body.innerHTML = ''; return; }
  panel.style.display = 'block';
  let html = '';
  for (const m of marks) {
    const col = m.side === 'long' ? '#ef4d4d' : '#2fbf71';
    html += '<div class="sim-pos">' +
      '<div class="sim-pos-h"><b style="color:' + col + '">' + (m.side === 'long' ? '多' : '空') + ' ' + m.leverage + 'x</b>' +
      '<span class="sim-st">' + (m.status === 'open' ? '持仓中' : '已平') + '</span></div>' +
      '<div class="sim-row"><span>均价</span><b>' + fmtPrice(m.entryPrice) + '</b></div>' +
      '<div class="sim-row"><span>数量</span><b>' + m.size + '</b></div>' +
      '<div class="sim-row"><span>保证金</span><b>' + fmtPrice(m.margin) + '</b></div>' +
      '<div class="sim-row"><span>止损</span><b style="color:#ff9a9a">' + (m.sl != null ? fmtPrice(m.sl) : '-') + '</b></div>' +
      '<div class="sim-row"><span>强平</span><b style="color:#ffb454">' + (m.liq != null ? fmtPrice(m.liq) : '-') + '</b></div>' +
      '<div class="sim-row"><span>已实现</span><b style="color:' + (m.realized >= 0 ? '#2fbf71' : '#ef4d4d') + '">' + (m.realized >= 0 ? '+' : '') + m.realized.toFixed(2) + '</b></div>' +
      '<div class="sim-row"><span>浮动</span><b style="color:' + (m.unrealized >= 0 ? '#2fbf71' : '#ef4d4d') + '">' + (m.unrealized >= 0 ? '+' : '') + m.unrealized.toFixed(2) + '</b></div>' +
      '</div>';
  }
  const st = simStore[simKey(curSym, cur)];
  if (st && st.log.length) {
    html += '<div class="sim-log-h">操作记录</div><div class="sim-log">';
    for (let i = st.log.length - 1; i >= Math.max(0, st.log.length - 8); i--) {
      const e = st.log[i];
      html += '<div class="sim-log-i">' + tsStr(e.t) + ' ' + e.msg + '</div>';
    }
    html += '</div>';
  }
  body.innerHTML = html;
}

function wireSim() {
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('simLong', () => simOpenAtCursor('long'));
  on('simShort', () => simOpenAtCursor('short'));
  on('simAdd', () => simAddAtCursor());
  on('simHalf', () => simExitAtCursor('half'));
  on('simFull', () => simExitAtCursor('full'));
  on('simClear', () => simClearPositions());
  on('simCloseX', () => { const p = document.getElementById('simPanel'); if (p) p.style.display = 'none'; });
}

async function importTradesFile(file) {
  if (typeof XLSX === 'undefined') { setTradeInfo('Excel 解析库未加载'); return; }
  setTradeInfo('解析 Excel 中…');
  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    const seen = new Set(); const bySym = {};
    for (const sn of wb.SheetNames) {
      const ws = wb.Sheets[sn];
      if (!ws) continue;
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (rows.length < 2) continue;
      const hdr = rows[0].map(c => String(c == null ? '' : c).trim());
      const idx = name => hdr.findIndex(h => h.includes(name));
      const iSym = idx('交易对'), iSide = idx('方向'), iE = idx('开仓均价'), iX = idx('平仓均价');
      let iBt = idx('买入时间'); if (iBt < 0) iBt = idx('开仓时间');
      let iSt = idx('卖出时间'); if (iSt < 0) iSt = idx('平仓时间');
      const iPnl = idx('收益'), iLev = idx('杠杆');
      if (iSym < 0) continue;
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const sym = normSym(row[iSym]);
        if (!sym) continue;
        const entryT = String(row[iBt] == null ? '' : row[iBt]).trim();
        if (!entryT) continue;
        const side = String(row[iSide] == null ? '' : row[iSide]).trim();
        const entryP = parseFloat(row[iE]);
        const exitT = String(row[iSt] == null ? '' : row[iSt]).trim();
        const exitP = parseFloat(row[iX]);
        const pnl = parseFloat(row[iPnl]);
        const key = sym + '|' + entryT + '|' + exitT + '|' + entryP;
        if (seen.has(key)) continue; seen.add(key);
        bySym[sym] = bySym[sym] || [];
        bySym[sym].push({
          side: side.includes('空') ? '空' : '多',
          entryT, entryP: isNaN(entryP) ? 0 : entryP,
          exitT, exitP: (exitT && !isNaN(exitP)) ? exitP : 0,
          pnl: isNaN(pnl) ? null : pnl,
          lev: isNaN(parseFloat(row[iLev])) ? null : parseFloat(row[iLev])
        });
      }
    }
    tradesBySym = bySym;
    for (const k in marksCache) delete marksCache[k];
    try { localStorage.setItem(TRADES_KEY, JSON.stringify(bySym)); } catch (e) {}
    const total = Object.values(bySym).reduce((a, b) => a + b.length, 0);
    const matched = Object.keys(bySym).length;
    setTradeInfo(`已导入 ${total} 笔 · ${matched} 个币种`);
    showTrades = true; const cb = document.getElementById('showTrades'); if (cb) cb.checked = true;
    resolveMarks();
  } catch (err) {
    setTradeInfo('导入失败：' + (err && err.message ? err.message : err));
  }
}

// 把每笔交易的 开/平时间 解析成本周期数据集里的 bar 索引（二分），结果按 币种|周期 缓存
async function resolveMarks() {
  const key = curSym + '|' + cur;
  if (marksCache[key]) { resolvedMarks = marksCache[key]; draw(); return; }
  const list = tradesBySym[curSym] || [];
  const marks = [];
  for (const t of list) {
    const ei = await findIdxByTime(t.entryT);
    if (ei < 0) continue;
    let xi = -1;
    if (t.exitT) { xi = await findIdxByTime(t.exitT); if (xi < 0) xi = -1; }
    marks.push({ side: t.side, ei, ep: t.entryP, xi, xp: t.exitP, pnl: t.pnl, lev: t.lev });
  }
  marksCache[key] = marks;
  resolvedMarks = marks;
  draw();
}

// 在 K 线上绘制 开仓/平仓 标注（多=红、空=绿，连线 + 收益标签）
function drawTrades() {
  if (!showTrades || !resolvedMarks || !resolvedMarks.length) return;
  const plotL = PAD_L, plotR = PAD_L + SCALE.plotW;
  const xW = SCALE.xW;
  ctx.save();
  ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'alphabetic';
  for (const m of resolvedMarks) {
    const ex = PAD_L + (m.ei - SCALE.viewStart + 0.5) * xW;
    if (ex < plotL - 40 || ex > plotR + 40) continue;
    const ey = SCALE.yP(m.ep);
    const col = m.side === '空' ? '#2fbf71' : '#ef4d4d';
    let xx = null, xy = null;
    if (m.xi >= 0 && m.xp > 0) { xx = PAD_L + (m.xi - SCALE.viewStart + 0.5) * xW; xy = SCALE.yP(m.xp); }
    if (xx != null && xx >= plotL - 40 && xx <= plotR + 40) {
      ctx.strokeStyle = col; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(xx, xy); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.fillStyle = '#0c0f16';
    ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.fillText('开', ex, ey - 7);
    if (xx != null && xx >= plotL - 40 && xx <= plotR + 40) {
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(xx, xy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillText('平', xx, xy + 13);
    }
    if (xx != null && m.pnl != null) {
      const mx = (ex + xx) / 2, my = (ey + xy) / 2;
      if (mx >= plotL - 50 && mx <= plotR + 50) {
        const txt = (m.side === '空' ? '空' : '多') + ' ' + (m.pnl >= 0 ? '+' : '') + m.pnl.toFixed(1);
        ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const w = ctx.measureText(txt).width + 10, h = 14;
        ctx.fillStyle = 'rgba(12,18,28,0.85)'; ctx.strokeStyle = col; ctx.lineWidth = 1;
        roundRect(mx - w / 2, my - h / 2, w, h, 3); ctx.fill(); ctx.stroke();
        ctx.fillStyle = col; ctx.fillText(txt, mx, my);
        ctx.font = '10px system-ui'; ctx.textBaseline = 'alphabetic';
      }
    }
  }
  ctx.restore();
}
function logP(p) { return Math.log(Math.max(p, 1e-9)); }
// 价格↔Y像素 映射（线性 / 对数 二选一）
function makeYMap(mainTop, mainBot, pmin, pmax) {
  if (logScale) {
    const Lmin = logP(pmin), Lmax = logP(pmax);
    return {
      yP: p => mainBot - (logP(p) - Lmin) / (Lmax - Lmin) * (mainBot - mainTop),
      pY: y => Math.exp(Lmin + (mainBot - y) / (mainBot - mainTop) * (Lmax - Lmin))
    };
  }
  return {
    yP: p => mainBot - (p - pmin) / (pmax - pmin) * (mainBot - mainTop),
    pY: y => pmin + (mainBot - y) / (mainBot - mainTop) * (pmax - pmin)
  };
}
// 对数坐标下生成 1/2/5×10^n 的人眼友好刻度
function logTicks(pmin, pmax) {
  const t = [];
  const e0 = Math.floor(Math.log10(Math.max(pmin, 1e-9)));
  const e1 = Math.ceil(Math.log10(pmax));
  for (let e = e0; e <= e1; e++)
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= pmin && v <= pmax) t.push(v);
    }
  return t;
}

// ---------- 数据源工厂 ----------
function makeInlineDS(arr) {
  return { len: arr.length, chunked: false, getBar: i => arr[i], ensure: () => {} };
}
function makeChunkedDS(meta) {
  const cache = new Map();   // ci -> array
  const loading = new Set();
  const chunkP = new Map();  // ci -> Promise（用于 await 等待加载完成）
  function loadChunk(ci) {
    if (cache.has(ci) || ci < 0 || ci >= meta.chunks) return Promise.resolve();
    if (chunkP.has(ci)) return chunkP.get(ci);
    const p = fetchChunk(meta, ci).then(arr => { cache.set(ci, arr); loading.delete(ci); chunkP.delete(ci); redrawSoon(); })
      .catch(() => { loading.delete(ci); chunkP.delete(ci); });
    loading.add(ci); chunkP.set(ci, p);
    return p;
  }
  return {
    len: meta.total, chunked: true,
    getBar(i) {
      const ci = Math.floor(i / meta.chunkSize);
      const c = cache.get(ci);
      return c ? c[i - ci * meta.chunkSize] : null;
    },
    // 等待某根K线所在分块加载完成（供 findIdxByTime 可靠定位）
    awaitBar(i) { return loadChunk(Math.floor(i / meta.chunkSize)); },
    // 确保 [a,b] 区间及左侧一块（EMA 上下文）已加载
    ensure(a, b) {
      a = Math.max(0, a); b = Math.min(meta.total - 1, b);
      const ci0 = Math.floor(a / meta.chunkSize), ci1 = Math.floor(b / meta.chunkSize);
      for (let ci = ci0; ci <= ci1; ci++) loadChunk(ci);
      if (ci0 > 0) loadChunk(ci0 - 1);
    }
  };
}

// ---------- IndexedDB 缓存（跨会话，第二次打开秒开）----------
const idbCache = (function () {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(STORAGE_NS + 'kline_cache_v1', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('chunks');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  return {
    async get(key) {
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const tx = db.transaction('chunks', 'readonly');
          const rq = tx.objectStore('chunks').get(key);
          rq.onsuccess = () => res(rq.result);
          rq.onerror = () => rej(rq.error);
        });
      } catch (e) { return null; }
    },
    async set(key, val) {
      try {
        const db = await open();
        await new Promise((res, rej) => {
          const tx = db.transaction('chunks', 'readwrite');
          tx.objectStore('chunks').put(val, key);
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
      } catch (e) {}
    },
    // 清理旧路径 fut_data/ 前缀的缓存键（数据已迁到 data/fut_data/）
    async purgeLegacy() {
      try {
        const db = await open();
        await new Promise((res) => {
          const tx = db.transaction('chunks', 'readwrite');
          const store = tx.objectStore('chunks');
          const rq = store.openCursor();
          rq.onsuccess = () => {
            const cur = rq.result;
            if (cur) {
              if (typeof cur.key === 'string' && cur.key.startsWith('fut_data/')) cur.delete();
              cur.continue();
            } else res();
          };
          rq.onerror = () => res();
        });
      } catch (e) {}
    }
  };
})();
// 启动时清理旧路径缓存，确保只认新 data/fut_data/ 键
idbCache.purgeLegacy().catch(() => {});

// file:// 下浏览器禁止 fetch 本地文件，改用 <script> 注入 wrapper .js（懒加载，每块~2MB）
const _chunkScriptPromises = {};
function loadChunkScript(meta, ci) {
  const key = meta.base + '_' + ci;
  if (window.__CHUNK__ && window.__CHUNK__[key]) return Promise.resolve(window.__CHUNK__[key]);
  if (_chunkScriptPromises[key]) return _chunkScriptPromises[key];
  _chunkScriptPromises[key] = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = meta.base + '_' + String(ci).padStart(4, '0') + '.js';
    sc.onload = () => resolve(window.__CHUNK__ ? window.__CHUNK__[key] : null);
    sc.onerror = () => { delete _chunkScriptPromises[key]; reject(new Error('load ' + sc.src + ' failed')); };
    document.head.appendChild(sc);
  });
  return _chunkScriptPromises[key];
}

async function fetchChunk(meta, ci) {
  const key = meta.base + '_' + ci;
  try { const c = await idbCache.get(key); if (c) return c; } catch (e) {}
  let arr = null;
  if (location.protocol === 'file:') {
    try { arr = await loadChunkScript(meta, ci); } catch (e) { arr = null; }
  } else {
    try {
      const url = meta.base + '_' + String(ci).padStart(4, '0') + '.json';
      const resp = await fetch(url);
      arr = await resp.json();
    } catch (e) { arr = null; }
  }
  if (arr) idbCache.set(key, arr).catch(() => {});
  return arr;
}

// §14 成交量归一化基准平滑：消除平移时单根爆量K线进出可视窗口导致的整屏柱子瞬时跳变。
// 根因：vmax 取「当前可视窗口」最大值，平移时爆量K线进出 → vmax 突变数倍（实测 1d 最大单步 2431%）→ 全屏柱子同时反向缩放。
const VMAX_SMOOTH = 0.18;      // 缓动系数（0=不跟随，1=瞬时跳变）；0.18 @60fps ≈ 0.39s 收敛
const VMAX_SNAP_RATIO = 3;     // 目标/当前偏差超过 3 倍时直接吸附（切换周期/大幅缩放不拖沓）
let volNormSmooth = 0;         // 平滑后的归一化基准（跨帧保持）

function redrawSoon() {
  if (drawScheduled) return;
  drawScheduled = true;
  requestAnimationFrame(() => { drawScheduled = false; draw(); rubberBounce(); });
}

// EMA（在已加载区间增量计算；缺口处重置，避免错位）
// ===== EMA 计算：Web Worker 异步（带主线程回退 + 区间缓存）=====
const emaCache = {};        // key "period:a:b" -> Float64Array
const emaInflight = {};     // key -> true（请求在途，避免重复发）
let emaWorker = null, emaReqId = 0;
function getEMAWorker() {
  if (emaWorker !== null) return emaWorker;
  try {
    const src = "self.onmessage=function(e){var d=e.data,n=d.closes.length,k=2/(d.period+1),out=new Float64Array(n),prev=NaN;for(var i=0;i<n;i++){var c=d.closes[i];if(c!==c){prev=NaN;out[i]=NaN;continue;}prev=isNaN(prev)?c:c*k+prev*(1-k);out[i]=prev;}self.postMessage({reqId:d.reqId,key:d.key,out:out},[out.buffer]);};";
    const blob = new Blob([src], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    emaWorker = new Worker(url);
    emaWorker.onmessage = function (ev) {
      const d = ev.data;
      emaCache[d.key] = d.out;
      emaInflight[d.key] = false;
      draw();
    };
    emaWorker.onerror = function () { emaWorker = null; };
  } catch (err) { emaWorker = null; }
  return emaWorker;
}
// EMA 全局序列：每个周期维护一条覆盖 [0, emaFullLen) 的连续数组。
// 平移/缩放时只增量推进末尾，不再每帧重算整窗（原 period:a:b 缓存因含 viewStart 几乎从不命中）。
const emaFull = {};       // period -> Float64Array（从 0 算到 emaFullLen[period]）
const emaFullLen = {};    // period -> 已计算到的索引数
function computeEMA(period, upto) {
  const total = DS ? DS.len : 0;
  const len = Math.max(0, Math.min(upto, total));
  if (len <= 0) return;
  let arr = emaFull[period];
  const start = emaFullLen[period] || 0;
  if (arr && start >= len) return;                       // 已覆盖到 upto，直接命中
  if (!arr) { arr = new Float64Array(Math.max(len, 1)); emaFull[period] = arr; emaFullLen[period] = 0; }
  else if (arr.length < len) { const n = new Float64Array(len); n.set(arr); arr = n; emaFull[period] = arr; }
  const k = 2 / (period + 1);
  let prev = emaFullLen[period] > 0 ? arr[emaFullLen[period] - 1] : NaN;
  for (let i = emaFullLen[period]; i < len; i++) {
    const bar = getBar(i); const c = bar ? +bar[4] : NaN;
    if (c !== c) { prev = NaN; arr[i] = NaN; }
    else { prev = isNaN(prev) ? c : c * k + prev * (1 - k); arr[i] = prev; }
  }
  emaFullLen[period] = len;
}

// 异步取某根K线（未加载则触发加载并等待完成，而非盲轮询）
function getBarAsync(i) {
  return new Promise(async res => {
    let b = getBar(i);
    if (b) return res(b);
    if (DS && typeof DS.awaitBar === 'function') {
      try { await DS.awaitBar(i); } catch (e) {}
    } else {
      DS.ensure(i, i);
    }
    res(getBar(i));
  });
}
// 在新数据集中按时间找最近K线索引（二分；时间戳为数字时零开销比较）
async function findIdxByTime(ts) {
  const len = DS.len;
  if (len === 0) return -1;
  const tTarget = tsMin(ts);
  const b0 = await getBarAsync(0), b1 = await getBarAsync(len - 1);
  if (!b0 || !b1) return -1;
  const t0 = tsMin(b0[0]);
  const t1 = tsMin(b1[0]);
  if (tTarget <= t0) return 0;
  if (tTarget >= t1) return len - 1;
  let lo = 0, hi = len - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = await getBarAsync(mid);
    if (!b) return -1;
    const tm = tsMin(b[0]);
    if (tm < tTarget) lo = mid + 1;
    else if (tm > tTarget) hi = mid - 1;
    else return mid;
  }
  return lo;
}

// ---------- 日期输入解析：支持 23-7-17 / 20230717 / 7-17 / ISO 等 ----------
function parseDateInput(s) {
  s = s.trim();
  const now = new Date();
  const Y = now.getUTCFullYear();

  // 已有 T 分隔（ISO）直接走 Date.parse
  if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}[T ]\d{1,2}/.test(s)) {
    const t = Date.parse(s.replace(/\//g, '-'));
    return isNaN(t) ? null : t;
  }

  // 紧凑 8 位：20230717 / 230717
  const compact = s.replace(/[^0-9]/g, '');
  if (/^(\d{4})(\d{2})(\d{2})$/.test(compact)) {
    const y = +compact.slice(0,4), m = +compact.slice(4,6), d = +compact.slice(6,8);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, m - 1, d);
  }
  if (/^(\d{2})(\d{2})(\d{2})$/.test(compact)) {
    const y = +compact.slice(0,2) < 50 ? 2000 + +compact.slice(0,2) : 1900 + +compact.slice(0,2);
    const m = +compact.slice(2,4), d = +compact.slice(4,6);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, m - 1, d);
  }

  // 短横线/斜杠/点分隔：23-7-17 / 2023-7-17 / 7-17-23
  const parts = s.split(/[-./]/);
  if (parts.length === 3) {
    let [a, b, c] = parts.map(Number);
    if (!a || !b || !c || isNaN(a) || isNaN(b) || isNaN(c)) return null;
    let y, m, d;
    if (a > 31) { y = a; m = b; d = c; }          // YYYY-M-D
    else if (c > 31) { y = c; m = a; d = b; }     // M-D-YYYY
    else {                                           // 三数均 ≤31：默认 YY-M-D
      y = a; m = b; d = c;
      // 若月份 >12 无效，尝试 M-D-YY 作为后备
      if (m < 1 || m > 12 || d < 1 || d > 31) { y = c; m = a; d = b; }
    }
    if (y < 100) y = y < 50 ? 2000 + y : 1900 + y;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, m - 1, d);
  }
  if (parts.length === 2) {
    let [m, d] = parts.map(Number);
    if (!m || !d || isNaN(m) || isNaN(d) || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return Date.UTC(Y, m - 1, d);
  }
  if (parts.length === 1) {
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }
  return null;
}

// ---------- 日期快速跳转（G 键 + 时间轴点击） ----------
function showGoToDialog() {
  if (goToOpen) return;
  goToOpen = true;
  const mask = document.createElement('div');
  mask.id = 'goToMask';
  mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:1000;font-family:system-ui,sans-serif;';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:#1a2030;border:1px solid #2a3142;border-radius:12px;padding:22px 24px;width:340px;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
  const title = document.createElement('div');
  title.textContent = '跳转到日期';
  title.style.cssText = 'font-size:15px;font-weight:700;color:#f0f3fa;margin-bottom:4px;';
  const sub = document.createElement('div');
  sub.textContent = '支持格式：23-7-17 / 20230717 / 7-17 / 2023-07-17';
  sub.style.cssText = 'font-size:11.5px;color:#5e6b82;margin-bottom:14px;';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '如 23-7-17 / 20230717 / 7-17';
  input.style.cssText = 'width:100%;background:#0e1220;border:1px solid #2a3142;color:#cdd3e0;border-radius:8px;padding:10px 12px;font-size:14px;font-family:Consolas,monospace;outline:none;box-sizing:border-box;';
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doJump(); });
  input.addEventListener('keydown', e => { if (e.key === 'Escape') closeGoTo(); });
  const ci = Math.max(0, Math.min(dataLen() - 1, Math.floor(viewStart + viewCount / 2)));
  const bar = getBar(ci);
  if (bar) {
    const s = tsStr(bar[0]).slice(0, 10); // YYYY-MM-DD
    const parts = s.split('-');
    input.value = parts[0].slice(2) + '-' + +parts[1] + '-' + +parts[2];
  }
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;margin-top:16px;justify-content:flex-end;';
  const btnCancel = document.createElement('button');
  btnCancel.textContent = '取消';
  btnCancel.style.cssText = 'background:#1c2433;color:#9aa6bd;border:1px solid #2a3142;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;';
  btnCancel.onclick = closeGoTo;
  const btnGo = document.createElement('button');
  btnGo.textContent = '跳转';
  btnGo.style.cssText = 'background:rgba(77,210,255,0.15);color:#9fe4ff;border:1px solid rgba(77,210,255,0.4);border-radius:8px;padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer;';
  btnGo.onclick = doJump;
  btns.appendChild(btnCancel); btns.appendChild(btnGo);
  panel.appendChild(title); panel.appendChild(sub); panel.appendChild(input); panel.appendChild(btns);
  mask.appendChild(panel);
  mask.addEventListener('mousedown', e => { if (e.target === mask) closeGoTo(); });
  document.body.appendChild(mask);
  input.focus();
  async function doJump() {
    const v = input.value.trim();
    if (!v) return;
    const t = parseDateInput(v);
    if (!t) { setLoading('日期格式无效'); return; }
    const idx = await findIdxByTime(t / 60000);
    if (idx < 0) return;
    viewStart = Math.max(vsLo(), Math.min(dataLen() - viewCount, idx - viewCount + 1));
    DS.ensure(Math.max(0, Math.floor(viewStart) - 200), Math.floor(viewStart) + viewCount);
    closeGoTo();
    redrawSoon(); scheduleViewSave();
  }
  function closeGoTo() {
    goToOpen = false;
    const el = document.getElementById('goToMask');
    if (el) el.remove();
  }
}

async function setView(sym, period) {
  for (const k in emaFull) delete emaFull[k];
  for (const k in emaFullLen) delete emaFullLen[k];
  volNormSmooth = 0;   // §14：切换标的/周期后重新吸附 VOL 基准，避免跨量纲长时间爬升
  if (DS) {   // 离开前保存当前画线 + 浏览位置
    linesStore[lineKey()] = lines;
    viewStore[sessionKey()] = { viewStart: Math.floor(viewStart), viewCount: viewCount };
  }
  if (sym) curSym = sym;
  if (period) cur = period;

  // 切换前先捕获锚点时间（鼠标在plot内取鼠标所在K线，否则取视图中心）
  let anchorTs = null;
  if (keepCursorTime && DS && dataLen() > 0) {
    const plotW = canvas.clientWidth - PAD_L - PAD_R;
    const inPlot = hover.x >= PAD_L && hover.x <= PAD_L + plotW && hover.y >= 0;
    let anchorIdx;
    if (inPlot) {
      const xW = plotW / viewCount;
      anchorIdx = Math.max(0, Math.min(dataLen() - 1, Math.floor(viewStart) + Math.floor((hover.x - PAD_L) / xW)));
    } else {
      anchorIdx = Math.max(0, Math.min(dataLen() - 1, Math.floor(viewStart + viewCount / 2)));
    }
    const bar = getBar(anchorIdx);
    if (bar) anchorTs = bar[0];
  }

  // 切换前捕获"右侧边缘时间"：切周期/标的时按此日期对齐右边缘（保持日期对齐，不跳来跳去）
  // §11 R1 修正：取真正最右可见根（e-1），而非可见区外第一根（viewStart+viewCount）
  let rightTs = null;
  if (DS && dataLen() > 0) {
    const rIdx = Math.max(0, Math.min(dataLen() - 1, Math.floor(viewStart + viewCount) - 1));
    const rBar = getBar(rIdx);
    if (rBar) rightTs = rBar[0];
  }

  // 画线按 标的 共享（时间戳锚定），切换周期/标的均保持显示；浏览位置按 标的|周期 独立记忆
  selectedLine = null; drawingTrend = null; drawingMeasure = null; drawingChannel = null; drawingHChannel = null;
  lines = Array.isArray(linesStore[curSym]) ? linesStore[curSym] : [];
  const s = SYMBOLS[curSym];
  const v = s.data[s.map[cur]];
  if (Array.isArray(v)) DS = makeInlineDS(v);
  else DS = makeChunkedDS(v);   // 分块描述对象（含 __chunked）
  const len = DS.len;
  // §11：viewCount 仅在首次启动（=0）或超界时设默认 260；
  // 周期切换/切标的时保持用户当前缩放级别（避免右侧时间对齐后视觉跳变）。
  if (viewCount <= 0 || viewCount > len) viewCount = Math.min(260, len);

  // 首次启动：恢复上次浏览位置（仅当标的+周期一致）
  if (RESTORE && RESTORE.sym === curSym && RESTORE.period === cur) {
    viewCount = Math.max(20, Math.min(len, RESTORE.viewCount));
    viewStart = Math.max(vsLo(), Math.min(len - viewCount, RESTORE.viewStart));
    RESTORE = null;
    syncPeriodButtons();
    DS.ensure(Math.max(0, Math.floor(viewStart) - 200), Math.floor(viewStart) + viewCount);
    draw();
    resolveMarks();
    return;
  }
  RESTORE = null;

  if (period) {
    // 切换周期：右侧边缘对齐到切换前视图的右侧日期（保持日期对齐，不跳来跳去）
    // 切换前若停在最右(最新)，则自然仍停在最右最新；若滚到过去某天，则停在那一天
    if (rightTs) {
      const ni = await findIdxByTime(rightTs);
      if (ni >= 0) {
        // §11 R1 修正：ni 显示在最右可见位置（viewStart = ni - viewCount + 1），
        // 避免 ni 落在不可见 e 位置导致最右可见偏 1 根
        viewStart = Math.max(vsLo(), Math.min(len - viewCount, ni - viewCount + 1));
      } else {
        viewStart = Math.max(vsLo(), len - viewCount);
      }
    } else {
      viewStart = Math.max(vsLo(), len - viewCount);
    }
  } else {
    // 切换标的（同周期）：优先恢复该 标的|周期 上次保存的浏览位置
    const savedView = viewStore[curSym + '|' + cur];
    if (savedView && typeof savedView.viewStart === 'number') {
      viewCount = Math.max(20, Math.min(len, savedView.viewCount || viewCount));
      viewStart = Math.max(vsLo(), Math.min(len - viewCount, savedView.viewStart));
      syncPeriodButtons();
      DS.ensure(Math.max(0, Math.floor(viewStart) - 200), Math.floor(viewStart) + viewCount);
      draw();
      resolveMarks();
      return;
    }

    if (anchorTs) {
      const ni = await findIdxByTime(anchorTs);
      if (ni >= 0) {
        const plotW = canvas.clientWidth - PAD_L - PAD_R;
        const inPlot = hover.x >= PAD_L && hover.x <= PAD_L + plotW && hover.y >= 0;
        if (inPlot) {
          const frac = (hover.x - PAD_L) / plotW;          // 锚点停在原屏幕横向位置
          viewStart = Math.max(vsLo(), Math.min(len - viewCount, ni - frac * viewCount));
        } else {
          viewStart = Math.max(vsLo(), Math.min(len - viewCount, ni - viewCount / 2)); // 锚点居中
        }
      } else {
        viewStart = Math.max(vsLo(), len - viewCount);
      }
    } else {
      viewStart = Math.max(vsLo(), len - viewCount);
    }
  }

  syncPeriodButtons();
  DS.ensure(Math.max(0, viewStart - 200), viewStart + viewCount);
  draw();
  resolveMarks();
}

function syncPeriodButtons() {
  const s = SYMBOLS[curSym];
  const avail = new Set(Object.keys(s.map).filter(k => s.data[s.map[k]] != null));
  document.querySelectorAll('.periods button').forEach(b => {
    const ok = avail.has(b.dataset.p);
    b.disabled = !ok;
    if (ok) b.classList.add('active'); else b.classList.remove('active');
  });
  if (!avail.has(cur)) cur = PERIODS.find(x => avail.has(x.p)).p;
  document.querySelector(`.periods button[data-p="${cur}"]`)?.classList.add('active');
  document.getElementById('title').textContent = curSym + ' · 时光机' + (APP_INSTANCE === 'live' ? '（看盘）' : '（复盘）');
}

function setLoading(msg) { document.getElementById('loading').textContent = msg || ''; }

function resize() {
  const r = canvas.getBoundingClientRect();
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

let SCALE = { pmin: 0, pmax: 1, mainTop: 0, mainBot: 1, plotW: 1, xW: 1, viewStart: 0, yP: p => 0, pY: () => 0 };

function draw() {
  if (!DS) return;
  const len = DS.len;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  ctx.clearRect(0, 0, W, H);
  if (!bgGrad || bgGradW !== W || bgGradH !== H) {
    bgGrad = ctx.createRadialGradient(W * 0.5, H * 0.32, 0, W * 0.5, H * 0.55, Math.max(W, H) * 0.85);
    bgGrad.addColorStop(0, '#171f2e'); bgGrad.addColorStop(1, '#0c0f16');
    bgGradW = W; bgGradH = H;
  }
  ctx.fillStyle = bgGrad; ctx.fillRect(0, 0, W, H);
  // §10 橡皮筋：内容整体横向偏移（背景不动，露出边界外空白）
  ctx.save();
  if (panRubber !== 0) ctx.translate(panRubber, 0);
  const plotW = W - PAD_L - PAD_R;
  const volH = H * volFrac, gap = 8;
  const mainTop = PAD_T, mainBot = PAD_T + (H - PAD_T - PAD_B - volH - gap);
  const volTop = mainBot + gap, volBot = H - PAD_B;
  const s = Math.floor(viewStart), e = Math.min(len, s + viewCount);   // §18：s 允许为负（左侧留空）；getBar 对负索引返回 null 安全跳过

  // 触发所需分块加载（可见区 + 左侧 EMA 上下文）
  DS.ensure(Math.max(0, s - 200), e);

  // 先算价格区间
  let pmin = Infinity, pmax = -Infinity, vmax = 0, anyLoaded = false;
  for (let i = s; i < e; i++) {
    const r = getBar(i);
    if (!r) continue;
    anyLoaded = true;
    const hi = +r[2], lo = +r[3], v = +r[5];
    if (hi > pmax) pmax = hi; if (lo < pmin) pmin = lo; if (v > vmax) vmax = v;
  }
  setLoading(DS.chunked && !anyLoaded ? '加载数据中…' : '');
  if (!anyLoaded) return;

  if (logScale && pmin > 0) {
    const pad = Math.pow(10, (Math.log10(pmax) - Math.log10(pmin)) * 0.04);
    pmax *= pad; pmin /= pad;
  } else {
    const padv = (pmax - pmin) * 0.08 || 1;
    pmax += padv; pmin -= padv;
  }
  const xW = plotW / (e - s);
  const cw = Math.max(1, xW * 0.66);
  const m = makeYMap(mainTop, mainBot, pmin, pmax);
  const yP = m.yP;
  const xI = i => PAD_L + (i + 0.5) * xW;
  SCALE = { pmin, pmax, mainTop, mainBot, plotW, xW, viewStart: s, yP: m.yP, pY: m.pY };

  // §20 年度分隔：可视区按 UTC 年切分 —— 交替极淡底色 + 年界细线 + 段内年份标签
  {
    const yOf = i => { const r = getBar(i); return r == null ? null : tsStr(r[0]).slice(0, 4); };
    const firstY = yOf(s);
    const total = e - s;
    if (firstY != null && total > 1) {
      // 视口可能含数十万根，用自适应步长扫年界，命中后再二分精确定位
      const scan = Math.max(1, Math.floor(total / 2000));
      const starts = [{ idx: s, year: firstY }];
      let prevY = firstY;
      for (let i = s + scan; i < e; i += scan) {
        const y = yOf(i);
        if (y == null) continue;
        if (y !== prevY) {
          let lo = i - scan, hi = i;
          while (lo < hi) { const mid = (lo + hi) >> 1; const ym = yOf(mid); if (ym === y) hi = mid; else lo = mid + 1; }
          starts.push({ idx: lo, year: y });
          prevY = y;
        }
      }
      if (starts.length > 1) {                       // 只有真正跨年才画，单一年份不打扰
        const xAt = i => PAD_L + (i - s) * xW;       // 该根 K 线的左边缘像素
        const yTop = mainTop, yBot = volBot;
        ctx.save();
        // 底色：偶数年加一层极淡提亮，形成交替区隔
        for (let k = 0; k < starts.length; k++) {
          if ((+starts[k].year) % 2 !== 0) continue;
          const x0 = k === 0 ? PAD_L : xAt(starts[k].idx);
          const x1 = k + 1 < starts.length ? xAt(starts[k + 1].idx) : PAD_L + plotW;
          ctx.fillStyle = 'rgba(255,255,255,0.032)';
          ctx.fillRect(x0, yTop, Math.max(0, x1 - x0), yBot - yTop);
        }
        // 年界细线（首段左界即视图边界，不画）
        ctx.strokeStyle = 'rgba(130,148,178,0.38)'; ctx.lineWidth = 1; ctx.setLineDash([]);
        for (let k = 1; k < starts.length; k++) {
          const x = Math.round(xAt(starts[k].idx)) + 0.5;
          ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke();
        }
        // 年份标签：贴主图顶部，跟在各自年的左边界后面
        ctx.font = 'bold 10px "SFMono-Regular", Consolas, monospace';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(155,171,195,0.85)';
        for (let k = 0; k < starts.length; k++) {
          const x0 = k === 0 ? PAD_L : xAt(starts[k].idx);
          ctx.fillText(starts[k].year, x0 + 4, yTop + 3);
        }
        ctx.restore();
      }
    }
  }

  // 网格 + 价格轴
  ctx.strokeStyle = '#1c2230'; ctx.fillStyle = '#6b7689';
  ctx.font = '11px "SFMono-Regular", Consolas, monospace'; ctx.textAlign = 'left';
  ctx.lineWidth = 1;
  if (logScale) {
    const ts = logTicks(pmin, pmax);
    for (const p of ts) {
      const y = yP(p);
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
      ctx.fillText(fmtPrice(p), PAD_L + plotW + 5, y + 3);
    }
  } else {
    const ticks = 5;
    for (let t = 0; t <= ticks; t++) {
      const p = pmin + (pmax - pmin) * t / ticks;
      const y = yP(p);
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
      ctx.fillText(p.toFixed(2), PAD_L + plotW + 5, y + 3);
    }
  }

  // 蜡烛 + 影线（大缩放 xW<1 时按像素桶聚合，避免逐根 canvas 调用）
  const nVis = e - s;
  const Wpx = Math.max(1, Math.round(plotW));
  // §16：桶边界改用连续 viewStart（而非整数 s），平移时桶窗口随 viewStart 连续滑动，
  //      消除缩小后平移时成交量/蜡烛"冻住→整批跳"的离散跳变（zoom-out 每拖 1px 偏移数十~上百根）
  const vs0 = viewStart;
  const bucketOf = (x) => {
    const i0 = Math.floor(vs0 + x * nVis / Wpx);   // §18：去 Math.max(0,…)，负值由 getBar 跳过 → 左侧自然留空
    const i1 = Math.min(len, Math.floor(vs0 + (x + 1) * nVis / Wpx));
    return { i0, i1 };
  };
  if (xW >= 1) {
    for (let i = s; i < e; i++) {
      const r = getBar(i);
      if (!r) continue;
      const o = +r[1], c = +r[4], h = +r[2], l = +r[3];
      const up = c >= o;
      ctx.strokeStyle = ctx.fillStyle = up ? '#ef4d4d' : '#2fbf71';
      const x = xI(i - s);
      ctx.beginPath(); ctx.moveTo(x, yP(h)); ctx.lineTo(x, yP(l)); ctx.stroke();
      const yo = yP(o), yc = yP(c);
      const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      if (xW > 2.2) ctx.fillRect(x - cw / 2, top, cw, bh);
      else ctx.fillRect(x - 0.5, top, 1, bh);
    }
  } else {
    for (let x = 0; x < Wpx; x++) {
      const { i0, i1 } = bucketOf(x);
      if (i1 <= i0) continue;
      let maxHi = -Infinity, minLo = Infinity, o = NaN, c = NaN, got = false;
      for (let i = i0; i < i1; i++) {
        const r = getBar(i);
        if (!r) continue;
        got = true;
        const h = +r[2], l = +r[3];
        if (h > maxHi) maxHi = h;
        if (l < minLo) minLo = l;
        if (i === i0) o = +r[1];
        c = +r[4];
      }
      if (!got) continue;
      const up = c >= o;
      ctx.strokeStyle = ctx.fillStyle = up ? '#ef4d4d' : '#2fbf71';
      const px = PAD_L + x + 0.5;
      ctx.beginPath(); ctx.moveTo(px, yP(maxHi)); ctx.lineTo(px, yP(minLo)); ctx.stroke();
      const yo = yP(o), yc = yP(c);
      const top = Math.min(yo, yc), bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(px - 0.5, top, 1, bh);
    }
  }

  // EMA 均线（全局序列缓存，平移/缩放只增量推进；大缩放按像素桶采样）
  function drawEMA(period, color, checked) {
    if (!checked) return;
    computeEMA(period, e);                 // 同步确保算到窗口右端（增量，几乎免费）
    const full = emaFull[period];
    if (!full) return;
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath();
    let started = false;
    if (xW >= 1) {
      for (let i = s; i < e; i++) {
        const v = full[i];
        if (v == null || Number.isNaN(v)) continue;
        const x = xI(i - s), y = yP(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
    } else {
      for (let x = 0; x < Wpx; x++) {
        const { i0, i1 } = bucketOf(x);
        const mid = i0 + Math.floor((i1 - i0) / 2);
        const v = full[mid];
        if (v == null || Number.isNaN(v)) continue;
        const px = PAD_L + x + 0.5, y = yP(v);
        if (!started) { ctx.moveTo(px, y); started = true; } else ctx.lineTo(px, y);
      }
    }
    ctx.stroke();
    for (let i = e - 1; i >= s; i--) {
      const v = full[i];
      if (v != null && !Number.isNaN(v)) {
        ctx.fillStyle = color; ctx.textAlign = 'left';
        ctx.fillText('EMA' + period, PAD_L + plotW + 4, yP(v) + 3);
        break;
      }
    }
  }
  drawEMA(20, '#ffb454', document.getElementById('ema20').checked);
  drawEMA(120, '#4ade80', document.getElementById('ema120').checked);

  // 成交量（大缩放按像素桶求和）
  if (vmax > 0) {
    // §14：先求本帧「归一化基准」，再统一平滑，两个分支共用 vNorm
    //      （根因：平移时爆量K线进出窗口 → 基准突变数倍 → 全屏柱子同时反向缩放）
    let sums = null, os = null, cs = null, gotB = null;
    // §14b 归一化基准 = 「本帧真正画出来的那个量」的最大值：
    //   小缩放（xW>=1）：每像素画 1 根 K 线   → 基准取视口内单根最大量 vmax
    //   大缩放（xW<1）：每像素画 1 个聚合桶   → 基准取桶和最大量 maxSum
    // 两个分支的「被画对象」在 xW=1 处重合（桶恰好 = 1 根），所以跨缩放天然连续、无断层；
    // 并且最粗的那根柱子刚好占满高度 → 既不会整片顶格，也不浪费纵向空间。
    // ⚠️ 两条反面教材（都已验证会更差）：
    //   ① 用分位数（P95）当基准 → 视口内量能跨量级时，一半柱子压到看不见、另一半顶格；
    //   ② 大缩放分支误用「单根最大量」vmax 当基准 → 桶和远大于 vmax，整屏全部顶格。
    //   而 ①② 之所以会被触发，根因不在渲染而在数据：2026-08-24 起追加的段误存了 OKX「张数」
    //   （1 张 = 0.01 BTC），比历史段（BTC 口径）大 100 倍 —— 见 update_data.cjs 的 CT_VAL 注释。
    //   数据口径统一之后，取「实际绘制量最大值」即为正确且最稳的选法。
    let targetNorm = vmax;
    if (xW < 1) {
      sums = new Float64Array(Wpx); os = new Float64Array(Wpx); cs = new Float64Array(Wpx); gotB = new Uint8Array(Wpx);
      let maxSum = 0;
      for (let x = 0; x < Wpx; x++) {
        const { i0, i1 } = bucketOf(x);
        if (i1 <= i0) continue;
        let sum = 0, o = NaN, c = NaN, got = false;
        for (let i = i0; i < i1; i++) {
          const r = getBar(i);
          if (!r) continue;
          got = true; sum += +r[5];
          if (i === i0) o = +r[1];
          c = +r[4];
        }
        if (!got) continue;
        sums[x] = sum; os[x] = o; cs[x] = c; gotB[x] = 1;
        if (sum > maxSum) maxSum = sum;
      }
      targetNorm = maxSum > 0 ? maxSum : vmax;   // 兜底：桶全空时退回 vmax
    }
    // 指数缓动平滑；首次 / 偏差超 3 倍（切换周期、大幅缩放）直接吸附，避免长时间爬升
    if (volNormSmooth <= 0 || targetNorm <= 0 ||
        targetNorm / volNormSmooth > VMAX_SNAP_RATIO ||
        volNormSmooth / targetNorm > VMAX_SNAP_RATIO) {
      volNormSmooth = targetNorm;
    } else {
      volNormSmooth += (targetNorm - volNormSmooth) * VMAX_SMOOTH;
    }
    const vNorm = volNormSmooth > 0 ? volNormSmooth : targetNorm;
    // 缓动未收敛则续帧（保证静止时收敛到真实基准，偏差阈值 0.1%）
    if (targetNorm > 0 && Math.abs(targetNorm - volNormSmooth) > targetNorm * 1e-3) redrawSoon();

    if (xW >= 1) {
      for (let i = s; i < e; i++) {
        const r = getBar(i);
        if (!r) continue;
        const v = +r[5], o = +r[1], c = +r[4];
        ctx.fillStyle = c >= o ? 'rgba(239,77,77,0.55)' : 'rgba(47,191,113,0.55)';
        // §14：改用平滑基准 vNorm，并 clamp（缓动过程中 v 可能短暂超过 vNorm）
        const x = xI(i - s), vh = Math.min((v / vNorm) * (volBot - volTop), volBot - volTop);
        ctx.fillRect(x - cw / 2, volBot - vh, cw, vh);
      }
    } else if (targetNorm > 0) {
      for (let x = 0; x < Wpx; x++) {
        if (!gotB[x]) continue;
        ctx.fillStyle = cs[x] >= os[x] ? 'rgba(239,77,77,0.55)' : 'rgba(47,191,113,0.55)';
        const vh = Math.min((sums[x] / vNorm) * (volBot - volTop), volBot - volTop);
        ctx.fillRect(PAD_L + x, volBot - vh, 1, vh);
      }
    }
    ctx.fillStyle = '#6b7689'; ctx.textAlign = 'left';
    ctx.fillText('VOL', PAD_L + 2, volTop + 12);
  }
  // 主图 / 成交量副图 分隔线（可上下拖动调节 VOL 高度）
  ctx.strokeStyle = '#222b3d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD_L, volTop); ctx.lineTo(PAD_L + plotW, volTop); ctx.stroke();
  {
    const hy = volTop - gap / 2;
    const over = hover.x >= PAD_L && hover.x <= PAD_L + plotW && Math.abs(hover.y - hy) <= 4;
    if (over && !dragVol) { canvas.style.cursor = 'row-resize'; }
    else if (!dragVol && canvas.style.cursor === 'row-resize' && toolMode === 'cursor' && !dragTarget && !drag) canvas.style.cursor = 'crosshair';
    ctx.fillStyle = over || dragVol ? '#3fd0ff' : '#2a3142';
    ctx.fillRect(PAD_L, hy - 1.5, plotW, 3);
  }

  // 时间轴（OKX 风格：自然间隔主刻度 + 次级刻度线 + 跨天首标签带日期）
  // 时间轴独立背景面板：与成交量区域完全隔离，日期清晰可读
  const taTop = volBot + 2;
  ctx.fillStyle = '#0e1219';
  ctx.fillRect(PAD_L - 2, taTop, plotW + 2, H - taTop);
  ctx.strokeStyle = '#222b3d'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD_L, taTop); ctx.lineTo(PAD_L + plotW, taTop); ctx.stroke();
  const PERIOD_MIN = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
  const pMin = PERIOD_MIN[cur] || 15;
  const visMin = nVis * pMin;                  // 可视时长（分钟）
  const targetMin = visMin / 7;                // 目标标签间隔
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440,
                 2880, 4320, 5760, 10080, 14400, 20160, 43200, 86400, 129600,
                 262800, 525600, 1051200, 2628000, 5256000, 13140000, 26280000];
  let intMin = steps[steps.length - 1];
  for (const st of steps) { if (st >= targetMin) { intMin = st; break; } }
  const step = Math.max(1, Math.round(intMin / pMin));
  const y0r = s < len ? String(getBar(s) ? tsStr(getBar(s)[0]).slice(0, 4) : '') : '';
  const lblTime = v => tsStr(v).slice(11, 16);        // HH:MM
  const lblDate = v => { const d = tsStr(v).slice(0, 10); return d.slice(0, 4) === y0r ? d.slice(5) : d; };  // MM-DD / YYYY-MM-DD
  const tsAt = i => { const r = getBar(i); return r ? r[0] : null; };
  ctx.font = '11px "SFMono-Regular", Consolas, monospace';
  const dayLevel = intMin >= 1440;
  // 次级刻度（主刻度中间，更短更暗，无文字）
  ctx.strokeStyle = '#2a3142'; ctx.lineWidth = 1;
  for (let i = s + Math.floor(step / 2); i < e; i += step) {
    ctx.beginPath(); ctx.moveTo(xI(i - s), taTop + 6); ctx.lineTo(xI(i - s), taTop + 9); ctx.stroke();
  }
  // 主刻度：刻度线 + 标签（分钟级：跨天首标带日期；天级：跨年标年份）
  ctx.strokeStyle = '#5a6478';
  let lastDay = null;
  for (let i = s; i < e; i += step) {
    const t = tsAt(i);
    if (t == null) continue;
    const x = xI(i - s);
    ctx.beginPath(); ctx.moveTo(x, taTop + 4); ctx.lineTo(x, taTop + 14); ctx.stroke();
    const day = tsStr(t).slice(0, 10);
    let label;
    if (dayLevel) label = lblDate(t);
    else if (day !== lastDay) label = lblDate(t) + ' ' + lblTime(t);
    else label = lblTime(t);
    lastDay = day;
    ctx.fillStyle = '#8a9ab0'; ctx.textAlign = 'center';
    ctx.fillText(label, x, taTop + 26);
  }

  // §15：价格类覆盖层裁剪到主图价格区 [mainTop, mainBot]，绝不进入成交量子面板（避免压住 VOL 柱子）
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD_L, mainTop, plotW, mainBot - mainTop);
  ctx.clip();
  drawLines();
  // §29 重叠提示：光标下若压着多个可选中对象，明说「再点一次切换」（否则用户不知道底下还有第二条，只能眼睁睁删不掉）
  if (toolMode === 'cursor' && !dragTarget && !dragStart && !dragVol &&
      hover.x >= PAD_L && hover.x <= PAD_L + SCALE.plotW && hover.y >= PAD_T && lines.length > 1) {
    const cs = hitTestAll(hover.x, hover.y);
    if (cs.length > 1) {
      const txt = '重叠 ' + cs.length + ' 个对象 · 再点一次切换';
      ctx.save();
      ctx.font = '11px system-ui, sans-serif';   // 与页面其它标注同一套字体
      const tw = ctx.measureText(txt).width;
      const bx = Math.max(PAD_L + 2, Math.min(PAD_L + SCALE.plotW - tw - 14, hover.x + 14));
      const by = Math.max(PAD_T + 4, Math.min(H - PAD_B - 26, hover.y + 14));
      ctx.fillStyle = 'rgba(20,27,42,0.94)';
      ctx.fillRect(bx, by, tw + 12, 19);
      ctx.strokeStyle = 'rgba(126,166,255,0.55)'; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.strokeRect(bx + 0.5, by + 0.5, tw + 11, 18);
      ctx.fillStyle = '#bcc9e2'; ctx.textAlign = 'left';
      ctx.fillText(txt, bx + 6, by + 13.5);
      ctx.restore();
    }
  }
  drawTrades();
  try { simReplay(curSym, cur, simCursorTs()); drawSim(); renderSim(); } catch (e) {}
  drawRRDraft();
  ctx.restore();
  updateTradePanel();



  // 十字光标（仅光标模式）+ 鼠标位置日期时间
  const inPlot = hover.x >= PAD_L && hover.x <= PAD_L + plotW && hover.y >= mainTop && hover.y <= volBot;
  if (toolMode === 'cursor' && inPlot) {
    ctx.strokeStyle = '#5a6478'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(hover.x, mainTop); ctx.lineTo(hover.x, volBot); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(PAD_L, hover.y); ctx.lineTo(PAD_L + plotW, hover.y); ctx.stroke();
    ctx.setLineDash([]);
    if (hover.y >= mainTop && hover.y <= mainBot) {
      const p = SCALE.pY(hover.y);
      ctx.fillStyle = '#cdd3e0'; ctx.fillText(fmtPrice(p), PAD_L + plotW + 5, hover.y + 3);
    }
    // 鼠标所在K线的日期时间（显示在十字光标竖线下方）
    const hoverIdx = Math.floor(SCALE.viewStart + (hover.x - PAD_L) / SCALE.xW);
    const hoverBar = getBar(hoverIdx);
    if (hoverBar) {
      const tsLabel = tsStr(hoverBar[0]);
      ctx.font = '11px "SFMono-Regular", Consolas, monospace';
      ctx.textAlign = 'center';
      const tw = ctx.measureText(tsLabel).width;
      const lx = hover.x, ly = taTop + 42;   // §13：下移到时间轴日期标签下方独立一行（不挡 VOL、不与日期撞 X）
      ctx.fillStyle = 'rgba(12,16,24,0.88)';
      ctx.fillRect(lx - tw / 2 - 5, ly - 11, tw + 10, 15);
      ctx.fillStyle = '#cdd3e0';
      ctx.fillText(tsLabel, lx, ly);
      ctx.textAlign = 'left';
    }
  }
  ctx.restore(); // §10 橡皮筋 translate 还原
}

// ---------- 画线逻辑 ----------
function priceToY(p) { return SCALE.yP(p); }
function yToPrice(y) { return SCALE.pY(y); }
function dataXToScreenX(dx) { return PAD_L + (dx - SCALE.viewStart + 0.5) * SCALE.xW; }
function xToIdx(x) { return SCALE.viewStart + (x - PAD_L) / SCALE.xW - 0.5; }
// 画线以"时间戳(分钟)"存储 X，从而跨周期/跨标的保持锚定同一日期
function _tsMin(v) { return typeof v === 'string' ? Date.parse(v.replace(' ', 'T')) / 60000 : v; }
function barTs(i) { const b = getBar(Math.round(i)); return b ? b[0] : null; }
function findIdxSync(ts) {
  const len = dataLen();
  if (len === 0) return -1;
  const tT = _tsMin(ts);
  const b0 = getBar(0), b1 = getBar(len - 1);
  if (!b0 || !b1) return -1;
  const t0 = _tsMin(b0[0]), t1 = _tsMin(b1[0]);
  if (tT <= t0) return 0;
  if (tT >= t1) return len - 1;
  let lo = 0, hi = len - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = getBar(mid);
    if (!b) return -1;
    const tm = _tsMin(b[0]);
    if (tm < tT) lo = mid + 1;
    else if (tm > tT) hi = mid - 1;
    else return mid;
  }
  return lo;
}
function lnIdx(ln, key) { return findIdxSync(ln[key]); }

function drawLines() {
  for (const ln of lines) {
    const isSel = ln === selectedLine;
    ctx.save();
    if (ln.type === 'hline') {
      const y = priceToY(ln.price);
      ctx.strokeStyle = isSel ? '#ff5d5d' : '#ff9a3d';
      ctx.lineWidth = isSel ? 2 : 1.4; ctx.setLineDash(isSel ? [] : [6, 4]);
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + SCALE.plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle; ctx.textAlign = 'left';
      ctx.fillText('H ' + fmtPrice(ln.price), PAD_L + 4, y - 4);
      if (isSel) drawHandle(PAD_L + SCALE.plotW - 4, y);
    } else if (ln.type === 'supply' || ln.type === 'demand') {
      // §24 供应线（绿）/ 需求线（红）：单点水平线；选中不改色，仅加粗+实线+右端手柄
      const st = HLEVEL_STYLE[ln.type];
      const y = priceToY(ln.price);
      ctx.strokeStyle = st.color;
      ctx.lineWidth = isSel ? 2.4 : 1.6;
      ctx.setLineDash(isSel ? [] : [6, 4]);
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + SCALE.plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      // §26 标注只留名称、不带价格数值（用户明确：供应线/需求线不需要给出数值）
      ctx.fillStyle = st.color; ctx.textAlign = 'left';
      ctx.fillText(st.label, PAD_L + 4, y - 4);
      if (isSel) drawHandle(PAD_L + SCALE.plotW - 4, y);
    } else if (ln.type === 'trend') {
      // 延长线：直线两端延伸至绘图区左右边缘（price 随 bar 索引线性外推）
      const i1 = lnIdx(ln, 'x1'), i2 = lnIdx(ln, 'x2');
      const idxL = SCALE.viewStart - 0.5, idxR = SCALE.viewStart + SCALE.plotW / SCALE.xW - 0.5;
      const tdx = i2 - i1;
      const k = tdx !== 0 ? (ln.y2 - ln.y1) / tdx : 0;
      const x1 = dataXToScreenX(idxL), y1 = priceToY(ln.y1 + k * (idxL - i1));
      const x2 = dataXToScreenX(idxR), y2 = priceToY(ln.y1 + k * (idxR - i1));
      ctx.strokeStyle = isSel ? '#ff5d5d' : '#b18cff';
      ctx.lineWidth = isSel ? 2 : 1.4;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (isSel) {
        drawHandle(dataXToScreenX(i1), priceToY(ln.y1));
        drawHandle(dataXToScreenX(i2), priceToY(ln.y2));
      }
    } else if (ln.type === 'channel') {
      // 通道：基线(A→B)与平行线(过C)，各自从自己的左侧锚点向右延伸成射线
      const i1 = lnIdx(ln, 'x1'), i2 = lnIdx(ln, 'x2'), i3 = lnIdx(ln, 'x3');
      const idxR = SCALE.viewStart + SCALE.plotW / SCALE.xW - 0.5;
      const tdx = i2 - i1;
      const k = tdx !== 0 ? (ln.y2 - ln.y1) / tdx : 0;
      const vL = SCALE.viewStart - 0.5;
      const bL = Math.max(i1, vL), pL = Math.max(i3, vL);   // 基线/平行线各自起点
      const aL = Math.max(bL, pL);                                 // 填充区域起点（两线公共段）
      const xR = Math.max(idxR, aL);
      const b1x = dataXToScreenX(bL), b1y = priceToY(ln.y1 + k * (bL - i1));
      const b2x = dataXToScreenX(xR), b2y = priceToY(ln.y1 + k * (xR - i1));
      const p1x = dataXToScreenX(pL), p1y = priceToY(ln.y3 + k * (pL - i3));
      const p2x = dataXToScreenX(xR), p2y = priceToY(ln.y3 + k * (xR - i3));
      const f1x = dataXToScreenX(aL), f1y = priceToY(ln.y1 + k * (aL - i1));
      const f2x = dataXToScreenX(aL), f2y = priceToY(ln.y3 + k * (aL - i3));
      ctx.fillStyle = isSel ? 'rgba(255,93,93,0.10)' : 'rgba(177,140,255,0.07)';
      ctx.beginPath(); ctx.moveTo(f1x, f1y); ctx.lineTo(b2x, b2y); ctx.lineTo(p2x, p2y); ctx.lineTo(f2x, f2y); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = isSel ? '#ff5d5d' : '#b18cff';
      ctx.lineWidth = isSel ? 2 : 1.4;
      ctx.beginPath(); ctx.moveTo(b1x, b1y); ctx.lineTo(b2x, b2y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p1x, p1y); ctx.lineTo(p2x, p2y); ctx.stroke();
      if (isSel) {
        drawHandle(dataXToScreenX(i1), priceToY(ln.y1));
        drawHandle(dataXToScreenX(i2), priceToY(ln.y2));
        drawHandle(dataXToScreenX(i3), priceToY(ln.y3));
      } else {
        const w = Math.abs((ln.y3 - ln.y1) - k * (i3 - i1));
        const cy = (b2y + p2y) / 2;
        const txt = fmtPrice(w);
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(txt).width + 12, th = 16;
        ctx.fillStyle = 'rgba(12,18,28,0.85)'; ctx.strokeStyle = '#b18cff'; ctx.lineWidth = 1;
        roundRect(b2x - tw, cy - th / 2, tw, th, 3); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#b18cff'; ctx.fillText(txt, b2x - 5, cy);
      }
    } else if (ln.type === 'hchannel') {
      // 水平通道：两条水平线（§25 上限绿=供应 / 下限红=需求）+ 淡紫区间填充，纯区间带、无任何数字标注
      const y1 = priceToY(ln.price1), y2 = priceToY(ln.price2);
      const plotL = PAD_L, plotR = PAD_L + SCALE.plotW;
      ctx.fillStyle = 'rgba(177,140,255,0.12)';   // 淡紫区间填充（选中/未选中一致）
      ctx.fillRect(plotL, Math.min(y1, y2), plotR - plotL, Math.abs(y2 - y1));
      ctx.lineWidth = isSel ? 2 : 1.4;
      ctx.setLineDash(isSel ? [] : [6, 4]);
      const upY = Math.min(y1, y2), dnY = Math.max(y1, y2);   // 上限=高价线，下限=低价线
      ctx.strokeStyle = HCHANNEL_STYLE.up;                      // §25 上限线：绿（供应）
      ctx.beginPath(); ctx.moveTo(plotL, upY); ctx.lineTo(plotR, upY); ctx.stroke();
      ctx.strokeStyle = HCHANNEL_STYLE.dn;                      // §25 下限线：红（需求）
      ctx.beginPath(); ctx.moveTo(plotL, dnY); ctx.lineTo(plotR, dnY); ctx.stroke();
      ctx.setLineDash([]);
      if (isSel) { drawHandle(plotR - 4, y1); drawHandle(plotR - 4, y2); }
    } else if (ln.type === 'measure') {
      const x1 = dataXToScreenX(lnIdx(ln, 'x1')), y1 = priceToY(ln.y1);
      const x2 = dataXToScreenX(lnIdx(ln, 'x2')), y2 = priceToY(ln.y2);
      ctx.strokeStyle = isSel ? '#ff5d5d' : '#3fd0ff';
      ctx.lineWidth = isSel ? 2 : 1.4;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (isSel) { drawHandle(x1, y1); drawHandle(x2, y2); }
      else drawMeasureLabel(x1, y1, x2, y2, ln.y1, ln.y2, lnIdx(ln, 'x1'), lnIdx(ln, 'x2'));
    } else if (ln.type === 'trade') {
      drawTrade(ln, isSel);
    }
    ctx.restore();
  }
  if (toolMode === 'trend' && drawingTrend) {
    const x1 = dataXToScreenX(lnIdx(drawingTrend, 'x1')), y1 = priceToY(drawingTrend.y1);
    ctx.strokeStyle = '#b18cff'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(hover.x, hover.y); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (toolMode === 'channel' && drawingChannel) {
    const d = drawingChannel;
    const hx = hover.x, hy = hover.y;
    ctx.strokeStyle = '#b18cff'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;
    if (d.phase === 1) {
      ctx.beginPath(); ctx.moveTo(dataXToScreenX(lnIdx(d, 'x1')), priceToY(d.y1)); ctx.lineTo(hx, hy); ctx.stroke();
    } else if (d.phase === 2) {
      const di1 = lnIdx(d, 'x1'), di2 = lnIdx(d, 'x2');
      const k = (di2 - di1) !== 0 ? (d.y2 - d.y1) / (di2 - di1) : 0;
      ctx.beginPath(); ctx.moveTo(dataXToScreenX(di1), priceToY(d.y1)); ctx.lineTo(dataXToScreenX(di2), priceToY(d.y2)); ctx.stroke();
      const idxR = SCALE.viewStart + SCALE.plotW / SCALE.xW - 0.5;
      const yHover = yToPrice(hy);
      ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(dataXToScreenX(idxR), priceToY(yHover + k * (idxR - xToIdx(hx)))); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  if (toolMode === 'measure' && drawingMeasure) {
    const x1 = dataXToScreenX(lnIdx(drawingMeasure, 'x1')), y1 = priceToY(drawingMeasure.y1);
    ctx.strokeStyle = '#3fd0ff'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(hover.x, hover.y); ctx.stroke();
    ctx.setLineDash([]);
    drawMeasureLabel(x1, y1, hover.x, hover.y, drawingMeasure.y1, yToPrice(hover.y), lnIdx(drawingMeasure, 'x1'), xToIdx(hover.x));
  }
  if (toolMode === 'hchannel' && drawingHChannel) {
    // 第一条水平线已定，跟随光标预览第二条
    const plotL = PAD_L, plotR = PAD_L + SCALE.plotW;
    const y1 = priceToY(drawingHChannel.price1), y2 = hover.y;
    ctx.fillStyle = 'rgba(177,140,255,0.12)';  // 预览填充与成品一致（淡紫）
    ctx.fillRect(plotL, Math.min(y1, y2), plotR - plotL, Math.abs(y2 - y1));
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1.2;
    ctx.strokeStyle = HCHANNEL_STYLE.up;   // §25 预览与成品同色：上限绿
    ctx.beginPath(); ctx.moveTo(plotL, Math.min(y1, y2)); ctx.lineTo(plotR, Math.min(y1, y2)); ctx.stroke();
    ctx.strokeStyle = HCHANNEL_STYLE.dn;   // §25 下限红
    ctx.beginPath(); ctx.moveTo(plotL, Math.max(y1, y2)); ctx.lineTo(plotR, Math.max(y1, y2)); ctx.stroke();
    ctx.setLineDash([]);
  }
}
// 测量标签：显示价格差、涨跌幅%、跨越K线根数
function drawMeasureLabel(x1, y1, x2, y2, p1, p2, idx1, idx2) {
  const dPrice = p2 - p1;
  const pct = p1 !== 0 ? (dPrice / p1 * 100) : 0;
  const bars = Math.abs(Math.round(idx2 - idx1)) + 1;
  const up = dPrice >= 0;
  const col = up ? '#ef4d4d' : '#2fbf71';
  const txt = `${dPrice >= 0 ? '+' : ''}${dPrice.toFixed(2)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)  · ${bars}根`;
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(txt).width + 16, h = 18;
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
  ctx.fillStyle = 'rgba(12,18,28,0.9)';
  ctx.strokeStyle = col; ctx.lineWidth = 1.2;
  roundRect(cx - w / 2, cy - h / 2, w, h, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = col;
  ctx.fillText(txt, cx, cy + 0.5);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}
function drawHandle(x, y) {
  ctx.fillStyle = '#ff5d5d';
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
}
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- 盈亏比计算（多/空：入场/止盈/止损三线，拖动实时算 R） ----------
// trade 作为 lines 元素 {type:'trade', entry, tp, sl, dir}，按 SYM|period 自动记忆
function closeAt(i) { const b = getBar(i); return b ? b[4] : null; }  // 入场K线收盘
function getTradePlan() { return lines.find(l => l.type === 'trade') || null; }
function setTradeHint(t) { const el = document.querySelector('#hint .tip-text'); if (el) el.innerHTML = t; }
// 进入创建模式：按住定入场 → 拖出止盈 → 再拖出止损
function initTradePlan() {
  const tp = getTradePlan();
  if (tp) { selectedLine = tp; syncTradeDir(tp.dir); return tp; }
  const dirEl = document.querySelector('#tradeDirSeg .seg-btn.active');
  rrDraft = { phase: 'tp', dir: dirEl ? dirEl.dataset.dir : 'long', idx: -1, entry: null, tp: null, sl: null };
  setTradeHint('按住画布：定入场K线 → 拖动松手定止盈 → 再拖动松手定止损');
  draw();
  return null;
}
function drawTrade(ln, isSel) {
  const { entry, tp, sl, dir } = ln;
  const plotL = PAD_L, plotR = PAD_L + SCALE.plotW;
  const cx = (typeof ln.idx === 'number') ? dataXToScreenX(ln.idx)
            : plotL + (ln.cx ?? 0.5) * SCALE.plotW;   // 锚定K线索引，缩放/平移时贴着该K线
  const rw = Math.min(170, SCALE.plotW * 0.40);
  const ye = priceToY(entry), yt = priceToY(tp), ys = priceToY(sl);
  const rx = cx - rw / 2;
  const rTop = Math.min(yt, ys), rBot = Math.max(yt, ys);
  // 双色填充矩形：盈利区（entry→tp）粉红 / 亏损区（entry→sl）绿
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = TCOL.profit;
  roundRect(rx, Math.min(ye, yt), rw, Math.abs(ye - yt), 6); ctx.fill();
  ctx.fillStyle = TCOL.risk;
  roundRect(rx, Math.min(ye, ys), rw, Math.abs(ye - ys), 6); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
  roundRect(rx, rTop, rw, rBot - rTop, 6); ctx.stroke();
  // 三条虚线延伸到图表边缘
  for (const [y, col] of [[yt, TCOL.profit], [ye, TCOL.entry], [ys, TCOL.risk]]) {
    ctx.strokeStyle = col; ctx.globalAlpha = 0.45; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  // 数值
  const riskP = Math.abs(entry - sl);
  const rewardP = Math.abs(tp - entry);
  const rr = riskP > 0 ? rewardP / riskP : 0;
  const pctRisk = entry !== 0 ? (riskP / entry * 100) : 0;
  const pctReward = entry !== 0 ? (rewardP / entry * 100) : 0;
  // 三个标签
  const lblW = Math.min(rw - 8, 156);
  function drawLabel(y, rows, alignRight, bgCol) {
    ctx.font = '11.5px "SFMono-Regular", Consolas, monospace';
    const txt = rows.join('\n');
    const mets = ctx.measureText(txt);
    const lineH = 15, padT = 7, padB = 7, padLR = 10;
    const lh = rows.length * lineH + padT + padB;
    const lw = Math.min(lblW, mets.width + padLR * 2);
    const lx = alignRight ? rx + rw - lw - 4 : rx + 4;
    const ly = y - lh / 2;
    ctx.fillStyle = 'rgba(12,14,22,0.92)';
    roundRect(lx, ly, lw, lh, 5); ctx.fill();
    ctx.strokeStyle = bgCol; ctx.lineWidth = 1.2; roundRect(lx, ly, lw, lh, 5); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let i = 0; i < rows.length; i++) {
      ctx.fillStyle = i === 0 ? bgCol : '#a8b4c4';
      ctx.font = i === 0 ? 'bold 11.5px "SFMono-Regular", Consolas, monospace' : '11.5px "SFMono-Regular", Consolas, monospace';
      ctx.fillText(rows[i], lx + padLR, ly + padT + i * lineH);
    }
  }
  drawLabel(yt, [`TP ${fmtPrice(tp)}`, `回报 ${pctReward >= 0 ? '+' : ''}${pctReward.toFixed(2)}%`], true, TCOL.profit);
  drawLabel(ye, [dir === 'long' ? '做多' : '做空', `盈亏比 ${rr.toFixed(2)}R`, `入场 ${fmtPrice(entry)}`], false, TCOL.entry);
  drawLabel(ys, [`SL ${fmtPrice(sl)}`, `风险 -${pctRisk.toFixed(2)}%`], true, TCOL.risk);
  // 拖拽手柄（入场在左，TP/SL 在右）
  for (const [key, y] of [['tp', yt], ['entry', ye], ['sl', ys]]) {
    const isSelH = isSel && dragTarget && dragTarget.line === ln && dragTarget.handle === key;
    const hx = (key === 'entry') ? rx - 6 : rx + rw + 2;
    ctx.fillStyle = isSelH ? '#fff' : TCOL.handle;
    ctx.strokeStyle = isSelH ? TCOL.handle : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.fillRect(hx - 4, y - 4, 8, 8);
    ctx.strokeRect(hx - 4, y - 4, 8, 8);
  }
}
// 拖动创建中的预览（rrDraft）：入场横线 + 正在拖的 TP/SL 虚线
function drawRRDraft() {
  if (!rrDraft) return;
  const plotL = PAD_L, plotR = PAD_L + SCALE.plotW;
  const cx = dataXToScreenX(rrDraft.idx);
  const rw = Math.min(170, SCALE.plotW * 0.40);
  const ye = priceToY(rrDraft.entry);
  const yt = rrDraft.tp != null ? priceToY(rrDraft.tp) : null;
  const ys = rrDraft.sl != null ? priceToY(rrDraft.sl) : null;
  ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
  for (const [y, col] of [[ye, TCOL.entry], [yt, TCOL.profit], [ys, TCOL.risk]]) {
    if (y == null) continue;
    ctx.strokeStyle = col; ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.moveTo(plotL, y); ctx.lineTo(plotR, y); ctx.stroke();
  }
  ctx.setLineDash([]); ctx.globalAlpha = 1;
  ctx.fillStyle = TCOL.entry; ctx.textAlign = 'left';
  ctx.font = 'bold 11.5px "SFMono-Regular", Consolas, monospace';
  ctx.fillText('入场 ' + fmtPrice(rrDraft.entry), plotL + 4, ye - 4);
  const hint = rrDraft.phase === 'tp' ? '松开鼠标 = 止盈 TP' : '松开鼠标 = 止损 SL';
  ctx.fillStyle = '#a8b4c4';
  ctx.fillText(hint, plotL + rw / 2, Math.min(ye, yt ?? ye, ys ?? ye) - 8);
}
function updateTradePanel() {
  const p = document.getElementById('tradePanel');
  const plan = getTradePlan();
  if (!plan) { p.classList.remove('show'); return; }
  p.classList.add('show');
  const { entry, tp, sl, dir } = plan;
  const riskP = Math.abs(entry - sl);
  const rewardP = Math.abs(tp - entry);
  const rr = riskP > 0 ? rewardP / riskP : 0;
  const winNeed = rr > 0 ? (1 / (1 + rr)) : 1;
  const ok = rr >= 2;
  const dirTxt = dir === 'long' ? '做多' : '做空';
  const d = document.getElementById('tradeDir');
  d.textContent = dirTxt; d.className = 'dir ' + (dir === 'long' ? 'dir-long' : 'dir-short');
  const ab = getBar(plan.idx);
  document.getElementById('tradeEntryTime').textContent = ab ? tsStr(ab[0]) : '-';
  document.getElementById('tradeEntry').textContent = fmtPrice(entry);
  document.getElementById('tradeTP').textContent = fmtPrice(tp) + '  (' + (rewardP >= 0 ? '+' : '') + (entry !== 0 ? (rewardP / entry * 100) : 0).toFixed(2) + '%)';
  document.getElementById('tradeSL').textContent = fmtPrice(sl) + '  (-' + (entry !== 0 ? (riskP / entry * 100) : 0).toFixed(2) + '%)';
  document.getElementById('tradeRR').textContent = rr.toFixed(2) + 'R  (1:' + rr.toFixed(1) + ')';
  const v = document.getElementById('tradeVerdict');
  if (riskP <= 0 || rewardP <= 0) {
    v.className = 'verdict vbad'; v.textContent = '⚠ 入场/止盈/止损需为不同价位';
  } else if (ok) {
    v.className = 'verdict vgood';
    v.textContent = `✓ 每 1R 风险搏 ${rr.toFixed(2)}R，胜率 ${(winNeed * 100).toFixed(1)}% 即可盈亏平衡`;
  } else {
    v.className = 'verdict vbad';
    v.textContent = `✗ 盈亏比仅 ${rr.toFixed(2)}R，需胜率 ${(winNeed * 100).toFixed(1)}% 才不亏`;
  }
}
function dist(a, b, c, d) { return Math.hypot(a - c, b - d); }
function ptSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(px, py, x1, y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(px, py, x1 + t * dx, y1 + t * dy);
}
// §29 命中测试：从「命中即返回」改为「收集全部候选再排序」。
//   旧写法（从最新往最旧扫、命中即 return）在对象重叠时会让被压住的那条永远点不中 → 也就删不掉：
//     · 供应线/需求线落在「水平通道」区间带内部  → 带内区域先命中，线本体点不到；
//     · 供应线与水平线价格几乎重合              → 只有后画的那条能选中。
//   新排序：① 优先级（端点手柄 0 < 细线本体 1 < 面状区域 2）
//          ② 距离（同优先级取更近的）
//          ③ 越新越优先（完全同距时保持「后画的在上」的直觉）
//   再配合 mousedown 里的「同一位置再点一次 → 轮换到下一个候选」，任何重叠对象都能选中并 Del 删除。
const HIT_TOL_EDGE = 6;     // 单点水平线 / 水平通道上下边
const HIT_TOL_HANDLE = 7;   // 端点手柄
const HIT_TOL_BODY = 5;     // 斜线本体
function hitTestAll(mx, my) {
  const out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    const rank = lines.length - 1 - i;                 // 0 = 最新画的
    const add = (handle, d, prio) => out.push({ line: ln, handle, d, prio, rank });
    if (ln.type === 'hline' || ln.type === 'supply' || ln.type === 'demand') {
      // §24 三者都是只有 price 的单点水平线，判定逻辑一致
      const d = Math.abs(my - priceToY(ln.price));
      if (d < HIT_TOL_EDGE) add('body', d, 1);
    } else if (ln.type === 'trend') {
      // 端点手柄按原始两点判定；body 命中按延长后的直线判定
      const i1 = lnIdx(ln, 'x1'), i2 = lnIdx(ln, 'x2');
      const idxL = SCALE.viewStart - 0.5, idxR = SCALE.viewStart + SCALE.plotW / SCALE.xW - 0.5;
      const tdx = i2 - i1;
      const k = tdx !== 0 ? (ln.y2 - ln.y1) / tdx : 0;
      const d1 = dist(mx, my, dataXToScreenX(i1), priceToY(ln.y1));
      const d2 = dist(mx, my, dataXToScreenX(i2), priceToY(ln.y2));
      if (d1 < HIT_TOL_HANDLE) add('p1', d1, 0);
      if (d2 < HIT_TOL_HANDLE) add('p2', d2, 0);
      const dB = ptSegDist(mx, my, dataXToScreenX(idxL), priceToY(ln.y1 + k * (idxL - i1)), dataXToScreenX(idxR), priceToY(ln.y1 + k * (idxR - i1)));
      if (dB < HIT_TOL_BODY) add('body', dB, 1);
    } else if (ln.type === 'channel') {
      const i1 = lnIdx(ln, 'x1'), i2 = lnIdx(ln, 'x2'), i3 = lnIdx(ln, 'x3');
      const d1 = dist(mx, my, dataXToScreenX(i1), priceToY(ln.y1));
      const d2 = dist(mx, my, dataXToScreenX(i2), priceToY(ln.y2));
      const d3 = dist(mx, my, dataXToScreenX(i3), priceToY(ln.y3));
      if (d1 < HIT_TOL_HANDLE) add('p1', d1, 0);
      if (d2 < HIT_TOL_HANDLE) add('p2', d2, 0);
      if (d3 < HIT_TOL_HANDLE) add('p3', d3, 0);
      const k = (i2 - i1) !== 0 ? (ln.y2 - ln.y1) / (i2 - i1) : 0;
      const idxL = SCALE.viewStart - 0.5, idxR = SCALE.viewStart + SCALE.plotW / SCALE.xW - 0.5;
      const bL = Math.max(i1, idxL), pL = Math.max(i3, idxL);   // 各自射线起点
      const b1 = { x: dataXToScreenX(bL), y: priceToY(ln.y1 + k * (bL - i1)) };
      const b2 = { x: dataXToScreenX(idxR), y: priceToY(ln.y1 + k * (idxR - i1)) };
      const p1 = { x: dataXToScreenX(pL), y: priceToY(ln.y3 + k * (pL - i3)) };
      const p2 = { x: dataXToScreenX(idxR), y: priceToY(ln.y3 + k * (idxR - i3)) };
      const dB = ptSegDist(mx, my, b1.x, b1.y, b2.x, b2.y);
      const dP = ptSegDist(mx, my, p1.x, p1.y, p2.x, p2.y);
      const dMin = Math.min(dB, dP);
      if (dB < HIT_TOL_BODY) add('body', dB, 1);
      else if (dP < HIT_TOL_BODY) add('body', dP, 1);
      else {
        const wPx = Math.hypot(b2.x - p2.x, b2.y - p2.y);
        if (dB + dP <= wPx + 8) add('body', dMin + 3, 2);   // 通道内部的「面」：最低优先级
      }
    } else if (ln.type === 'hchannel') {
      const y1 = priceToY(ln.price1), y2 = priceToY(ln.price2);
      const d1 = Math.abs(my - y1), d2 = Math.abs(my - y2);
      if (d1 < HIT_TOL_EDGE) add('p1', d1, 1);
      if (d2 < HIT_TOL_EDGE) add('p2', d2, 1);
      const top = Math.min(y1, y2), bot = Math.max(y1, y2);
      // §29 区间带内部优先级最低：否则「放在通道带里的供应线/需求线」会被整条带子吞掉，点不中
      if (my > top && my < bot) add('body', Math.min(d1, d2), 2);
    } else if (ln.type === 'measure') {
      const x1 = dataXToScreenX(lnIdx(ln, 'x1')), y1 = priceToY(ln.y1);
      const x2 = dataXToScreenX(lnIdx(ln, 'x2')), y2 = priceToY(ln.y2);
      const d1 = dist(mx, my, x1, y1), d2 = dist(mx, my, x2, y2);
      if (d1 < HIT_TOL_HANDLE) add('p1', d1, 0);
      if (d2 < HIT_TOL_HANDLE) add('p2', d2, 0);
      const dB = ptSegDist(mx, my, x1, y1, x2, y2);
      if (dB < HIT_TOL_BODY) add('body', dB, 1);
    } else if (ln.type === 'trade') {
      const plotL = PAD_L, plotR = PAD_L + SCALE.plotW;
      const cx = (typeof ln.idx === 'number') ? dataXToScreenX(ln.idx)
                : plotL + (ln.cx ?? 0.5) * SCALE.plotW, rw = Math.min(170, SCALE.plotW * 0.40);
      const rx = cx - rw / 2;
      for (const key of ['tp', 'entry', 'sl']) {
        const d = Math.abs(my - priceToY(ln[key]));
        if (mx >= rx - 16 && mx <= rx + rw + 16 && d <= 26) add(key, d, 1);   // 命中明细按距离排序
      }
      // 矩形主体空白处：拖动 = 整体移动（水平移 cx，垂直平移三线）
      const rTop = Math.min(priceToY(ln.tp), priceToY(ln.sl)), rBot = Math.max(priceToY(ln.tp), priceToY(ln.sl));
      if (mx >= rx && mx <= rx + rw && my >= rTop && my <= rBot) add('move', Math.min(Math.abs(my - rTop), Math.abs(my - rBot)), 2);
    }
  }
  // ① 优先级 ② 距离 ③ 越新越优先
  out.sort((a, b) => (a.prio - b.prio) || (a.d - b.d) || (a.rank - b.rank));
  return out;
}
// 兼容旧调用：返回最佳候选（原 {line, handle} 结构）
function hitTest(mx, my) {
  const c = hitTestAll(mx, my)[0];
  return c ? { line: c.line, handle: c.handle } : null;
}

// ---------- 鼠标事件 ----------
let drag = false, lastX = 0, dragStart = null;
let lastPick = null;   // §29 上一次命中的对象与位置（同一位置再点一次 → 轮换到下一个候选）
let dragVol = false;   // 正在拖动成交量分隔条

// 画完一条线后退出画线模式，回到光标（保存结果，不再连续画）
function exitToolMode() {
  toolMode = 'cursor';
  document.querySelectorAll('.tools button[data-tool]').forEach(x => x.classList.remove('active'));
  const c = document.querySelector('.tools button[data-tool="cursor"]');
  if (c) c.classList.add('active');
  canvas.style.cursor = 'crosshair';
}

canvas.addEventListener('mousedown', e => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;

  // 时间轴区域点击：视图居中到点击处的K线
  if (my >= canvas.clientHeight - PAD_B && dataLen() > 0) {
    const plotW = canvas.clientWidth - PAD_L - PAD_R;
    if (mx >= PAD_L && mx <= PAD_L + plotW) {
      const frac = Math.max(0, Math.min(1, (mx - PAD_L) / plotW));
      const targetIdx = Math.floor(viewStart + frac * viewCount);
      viewStart = Math.max(vsLo(), Math.min(dataLen() - viewCount, targetIdx - viewCount / 2));
      DS.ensure(Math.max(0, Math.floor(viewStart) - 200), Math.floor(viewStart) + viewCount);
      redrawSoon(); scheduleViewSave();
    }
    return;
  }

  if (toolMode === 'hline') {
    lines.push({ type: 'hline', price: yToPrice(my) });
    selectedLine = lines[lines.length - 1];
    draw(); scheduleSessionSave(); exitToolMode(); return;
  }
  if (toolMode === 'supply' || toolMode === 'demand') {
    // §24 供应线/需求线：单击即创建（与 hline 一致，不受「连画」影响）
    lines.push({ type: toolMode, price: yToPrice(my) });
    selectedLine = lines[lines.length - 1];
    draw(); scheduleSessionSave(); exitToolMode(); return;
  }
  if (toolMode === 'trend') {
    const dx = xToIdx(mx), ts = barTs(dx), price = yToPrice(my);
    if (!drawingTrend) { drawingTrend = { x1: ts, y1: price }; draw(); }
    else {
      lines.push({ type: 'trend', x1: drawingTrend.x1, y1: drawingTrend.y1, x2: ts, y2: price });
      selectedLine = lines[lines.length - 1];
      drawingTrend = null; draw(); scheduleSessionSave(); if (!continuousDraw) exitToolMode();   // 画完保存；非连画模式则退出
    }
    return;
  }
  if (toolMode === 'channel') {
    const dx = xToIdx(mx), ts = barTs(dx), price = yToPrice(my);
    if (!drawingChannel) drawingChannel = { phase: 1, x1: ts, y1: price };
    else if (drawingChannel.phase === 1) { drawingChannel.x2 = ts; drawingChannel.y2 = price; drawingChannel.phase = 2; }
    else {
      lines.push({ type: 'channel', x1: drawingChannel.x1, y1: drawingChannel.y1, x2: drawingChannel.x2, y2: drawingChannel.y2, x3: ts, y3: price });
      selectedLine = lines[lines.length - 1];
      drawingChannel = null; draw(); scheduleSessionSave(); if (!continuousDraw) exitToolMode();
    }
    draw();
    return;
  }
  if (toolMode === 'hchannel') {
    const price = yToPrice(my);
    if (!drawingHChannel) { drawingHChannel = { price1: price }; draw(); }
    else {
      lines.push({ type: 'hchannel', price1: drawingHChannel.price1, price2: price });
      selectedLine = lines[lines.length - 1];
      drawingHChannel = null; draw(); scheduleSessionSave(); if (!continuousDraw) exitToolMode();
    }
    return;
  }
  if (toolMode === 'measure') {
    const dx = xToIdx(mx), ts = barTs(dx), price = yToPrice(my);
    if (!drawingMeasure) { drawingMeasure = { x1: ts, y1: price }; draw(); }
    else {
      lines.push({ type: 'measure', x1: drawingMeasure.x1, y1: drawingMeasure.y1, x2: ts, y2: price });
      selectedLine = lines[lines.length - 1];
      drawingMeasure = null; draw(); scheduleSessionSave(); if (!continuousDraw) exitToolMode();
    }
    return;
  }
  // 盈亏比创建：按下定入场 → 拖动中预览 → 松手定 TP/SL
  if (tradeMode && !getTradePlan()) {
    if (!rrDraft) {
      const ni = Math.max(0, Math.min(dataLen() - 1, Math.round(xToIdx(mx))));
      const c = closeAt(ni);
      if (c == null) { draw(); return; }
      const dirEl = document.querySelector('#tradeDirSeg .seg-btn.active');
      rrDraft = { phase: 'tp', dir: dirEl ? dirEl.dataset.dir : 'long', idx: ni, entry: c, tp: null, sl: null };
    }
    draw();
    return;
  }
  // 光标模式：选中已有线 / 准备拖拽 / 空白处按住拖动平移
  // 成交量分隔条：在分隔线附近按下 -> 拖动调节 VOL 高度
  {
    const H = canvas.clientHeight, plotW = canvas.clientWidth - PAD_L - PAD_R;
    const volH = H * volFrac, gap = 8;
    const mainBot = PAD_T + (H - PAD_T - PAD_B - volH - gap);
    const volTop = mainBot + gap, hy = volTop - gap / 2;
    if (mx >= PAD_L && mx <= PAD_L + plotW && Math.abs(my - hy) <= 5) {
      dragVol = true; canvas.style.cursor = 'row-resize'; draw(); return;
    }
  }
  // §29 命中：同一处可能压着多个对象（重叠线 / 线落在水平通道带内）——
  //     取最优候选；若「同一位置再点一次」，则轮换到下一个候选（保证任何一条都能选中 → Del 删除）
  const cands = hitTestAll(mx, my);
  let hit = cands.length ? cands[0] : null;
  if (cands.length > 1 && lastPick &&
      Math.abs(mx - lastPick.mx) < 5 && Math.abs(my - lastPick.my) < 5) {
    const pi = cands.findIndex(c => c.line === lastPick.line && c.handle === lastPick.handle);
    hit = cands[(pi + 1) % cands.length];
  }
  lastPick = hit ? { mx, my, line: hit.line, handle: hit.handle } : null;
  if (hit) {
    selectedLine = hit.line;
    dragTarget = hit;
    if (hit.line.type === 'trend' && hit.handle === 'body') {
      dragStart = { mx: e.clientX, my: e.clientY, y1: hit.line.y1, y2: hit.line.y2, line: hit.line };
    } else if (hit.line.type === 'channel' && hit.handle === 'body') {
      dragStart = { mx: e.clientX, my: e.clientY, y1: hit.line.y1, y2: hit.line.y2, y3: hit.line.y3, line: hit.line };
    } else if (hit.line.type === 'hchannel' && hit.handle === 'body') {
      dragStart = { mx: e.clientX, my: e.clientY, price1: hit.line.price1, price2: hit.line.price2, line: hit.line };
    } else if (hit.line.type === 'hline' || hit.line.type === 'supply' || hit.line.type === 'demand') {
      // §26 单点水平线：整条上下拖动改价（window mousemove 也兜住「光标移出画布」的继续拖动）
      dragStart = { mx: e.clientX, my: e.clientY, price: hit.line.price, line: hit.line };
    } else if (hit.line.type === 'trade' && hit.handle === 'move') {
      const idx0 = (typeof hit.line.idx === 'number') ? hit.line.idx : (hit.line.cx ?? 0.5) * viewCount + SCALE.viewStart;
      dragStart = { mx: e.clientX, my: e.clientY, entry: hit.line.entry, tp: hit.line.tp, sl: hit.line.sl, idx: idx0, line: hit.line };
    }
  } else {
    selectedLine = null;
    drag = true;            // 启动拖拽平移
    lastX = e.clientX;
    canvas.style.cursor = 'grabbing';
  }
  draw();
});

canvas.addEventListener('mousemove', e => {
  const rect = canvas.getBoundingClientRect();
  hover.x = e.clientX - rect.left; hover.y = e.clientY - rect.top;

  if (toolMode === 'hline' || toolMode === 'supply' || toolMode === 'demand' || toolMode === 'trend' || toolMode === 'channel' || toolMode === 'hchannel') { redrawSoon(); return; }

  // 盈亏比创建：拖动预览 TP/SL
  if (tradeMode && rrDraft && !getTradePlan()) {
    if (rrDraft.phase === 'tp') rrDraft.tp = yToPrice(hover.y);
    else if (rrDraft.phase === 'sl') rrDraft.sl = yToPrice(hover.y);
    redrawSoon(); return;
  }

  if (dragTarget) {
    const ln = dragTarget.line;
    if (ln.type === 'hline' || ln.type === 'supply' || ln.type === 'demand') {
      // §24 单点水平线：整体上下拖动改价
      if (dragTarget.handle === 'body') ln.price = yToPrice(hover.y);
    } else if (ln.type === 'hchannel') {
      if (dragTarget.handle === 'p1') ln.price1 = yToPrice(hover.y);
      else if (dragTarget.handle === 'p2') ln.price2 = yToPrice(hover.y);
    } else if (ln.type === 'trend' || ln.type === 'measure' || ln.type === 'channel') {
      const price = yToPrice(hover.y), ts = barTs(xToIdx(hover.x));
      if (dragTarget.handle === 'p1') { ln.x1 = ts; ln.y1 = price; }
      else if (dragTarget.handle === 'p2') { ln.x2 = ts; ln.y2 = price; }
      else if (dragTarget.handle === 'p3') { ln.x3 = ts; ln.y3 = price; }
    } else if (ln.type === 'trade') {
      if (dragTarget.handle === 'entry') {
        // 拖入场手柄 = 换入场K线：idx 指向光标所在K线，entry 铆钉其收盘
        const ni = Math.max(0, Math.min(dataLen() - 1, Math.round(xToIdx(hover.x))));
        ln.idx = ni; delete ln.cx;
        const c = closeAt(ni); if (c != null) ln.entry = c;
      } else {
        ln[dragTarget.handle] = yToPrice(hover.y);   // TP/SL 自由调
      }
    }
    redrawSoon(); return;
  }

  if (dragVol) {
    const H = canvas.clientHeight, gap = 8;
    // 主图底边 mainBot = PAD_T + (H - PAD_T - PAD_B - volH - gap)，其中 volH = H*volFrac
    // => hover.y ≈ PAD_T + (1 - volFrac)*H - PAD_B - gap  => volFrac ≈ 1 - (hover.y - PAD_T + PAD_B + gap)/H
    let vf = 1 - (hover.y - PAD_T + PAD_B + gap) / H;
    volFrac = Math.max(0.06, Math.min(0.6, vf));
    savePrefs();
    redrawSoon(); return;
  }

  if (drag) {
    const dx = e.clientX - lastX; lastX = e.clientX;
    const len = dataLen(), plotW = canvas.clientWidth - PAD_L - PAD_R;
    const xW = plotW / viewCount;
    viewStart = Math.max(vsLo(), Math.min(len - viewCount, viewStart - dx / xW));
    DS.ensure(Math.max(0, Math.floor(viewStart) - 200), Math.floor(viewStart) + viewCount);
  }
  redrawSoon(); scheduleViewSave();
});

window.addEventListener('mousemove', e => {
  if (!dragStart) return;
  if (dragStart.line.type === 'hline' || dragStart.line.type === 'supply' || dragStart.line.type === 'demand') {
    // §26 单点水平线：直接用光标高度定价格（价格恒定 → 拖出画布再回来不会跳动）
    const rect = canvas.getBoundingClientRect();
    dragStart.line.price = yToPrice(e.clientY - rect.top);
    redrawSoon();
    return;
  }
  if (dragStart.line.type === 'trade') {
    // 入场点铆钉到所在K线收盘：水平移动改 idx，entry 始终 = 该K线收盘
    const dIdx = (e.clientX - dragStart.mx) / SCALE.xW;
    dragStart.line.idx = Math.max(0, Math.min(dataLen() - 1, dragStart.idx + dIdx));
    delete dragStart.line.cx;   // 旧数据首次拖动即迁移到 idx 模型
    const c = closeAt(dragStart.line.idx);
    if (c != null) dragStart.line.entry = c;
    // 垂直拖动只平移 TP/SL（保持相对价差），入场K线不动
    const dy = dragStart.my - e.clientY;
    if (logScale) {
      const dLog = dy / (SCALE.mainBot - SCALE.mainTop) * (logP(SCALE.pmax) - logP(SCALE.pmin));
      dragStart.line.tp = Math.exp(logP(dragStart.tp) + dLog);
      dragStart.line.sl = Math.exp(logP(dragStart.sl) + dLog);
    } else {
      const dPrice = dy / (SCALE.mainBot - SCALE.mainTop) * (SCALE.pmax - SCALE.pmin);
      dragStart.line.tp = dragStart.tp + dPrice;
      dragStart.line.sl = dragStart.sl + dPrice;
    }
    redrawSoon();
    return;
  }
  const dy = dragStart.my - e.clientY;
  if (dragStart.line.type === 'hchannel') {
    // 水平通道：上下两条线一起平移（价差不变）
    if (logScale) {
      const dLog = dy / (SCALE.mainBot - SCALE.mainTop) * (logP(SCALE.pmax) - logP(SCALE.pmin));
      dragStart.line.price1 = Math.exp(logP(dragStart.price1) + dLog);
      dragStart.line.price2 = Math.exp(logP(dragStart.price2) + dLog);
    } else {
      const dPrice = dy / (SCALE.mainBot - SCALE.mainTop) * (SCALE.pmax - SCALE.pmin);
      dragStart.line.price1 = dragStart.price1 + dPrice;
      dragStart.line.price2 = dragStart.price2 + dPrice;
    }
    redrawSoon();
    return;
  }
  if (logScale) {
    const dLog = dy / (SCALE.mainBot - SCALE.mainTop) * (logP(SCALE.pmax) - logP(SCALE.pmin));
    dragStart.line.y1 = Math.exp(logP(dragStart.y1) + dLog);
    dragStart.line.y2 = Math.exp(logP(dragStart.y2) + dLog);
    if (dragStart.line.type === 'channel') dragStart.line.y3 = Math.exp(logP(dragStart.y3) + dLog);
  } else {
    const dPrice = dy / (SCALE.mainBot - SCALE.mainTop) * (SCALE.pmax - SCALE.pmin);
    dragStart.line.y1 = dragStart.y1 + dPrice;
    dragStart.line.y2 = dragStart.y2 + dPrice;
    if (dragStart.line.type === 'channel') dragStart.line.y3 = dragStart.y3 + dPrice;
  }
  redrawSoon();
});
window.addEventListener('mouseup', () => {
  if (tradeMode && rrDraft && !getTradePlan()) {
    if (rrDraft.phase === 'tp' && rrDraft.tp != null) {
      rrDraft.phase = 'sl'; draw(); return;          // TP 已定，进入拖 SL
    } else if (rrDraft.phase === 'sl' && rrDraft.sl != null) {
      const plan = { type: 'trade', entry: rrDraft.entry, tp: rrDraft.tp, sl: rrDraft.sl, dir: rrDraft.dir, idx: rrDraft.idx };
      lines.push(plan); selectedLine = plan;
      rrDraft = null;
      tradeMode = false;
      document.getElementById('tradeEnter').classList.remove('trade-active');
      setTradeHint('滚轮缩放 · 拖拽平移 · <kbd>←</kbd><kbd>→</kbd> 逐根步进 · <kbd>G</kbd> 日期跳转 · <kbd>Del</kbd> 删除选中 · 拖线或 <kbd>↑</kbd><kbd>↓</kbd> 上下移 · 「盈亏比」拖出入场/止盈/止损');
      exitToolMode();
      draw(); scheduleSessionSave();
      return;
    }
  }
  drag = false; dragTarget = null; dragStart = null; dragVol = false; canvas.style.cursor = 'crosshair'; scheduleSessionSave();
});
canvas.addEventListener('mouseleave', () => { if (!drag) { hover.x = -1; hover.y = -1; redrawSoon(); } });

// 键盘
window.addEventListener('keydown', e => {
  if (goToOpen) return;   // 跳转对话框打开时屏蔽全部快捷键（含 Delete/箭头，避免误操作画线）
  if (e.key === 'Delete' || e.key === 'Del' || e.key === 'Backspace') {
    if (selectedLine) { lines = lines.filter(l => l !== selectedLine); selectedLine = null; draw(); scheduleSessionSave(); }
    return;
  }
  if (e.key === 'g' || e.key === 'G') {
    if (toolMode !== 'cursor') return;
    e.preventDefault();
    showGoToDialog();
    return;
  }
  // §26 ↑/↓ 上下微调「选中的水平线」（供应线/需求线/水平线 单点线，以及水平通道整体）；按住 Shift 步长 ×5
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (toolMode !== 'cursor' || !selectedLine || !SCALE || SCALE.plotW <= 1) return;
    const ln = selectedLine;
    const dPx = (e.key === 'ArrowUp' ? -1 : 1) * (e.shiftKey ? 10 : 2);   // 屏幕上移 = 价格上行
    if (ln.type === 'hline' || ln.type === 'supply' || ln.type === 'demand') {
      const np = yToPrice(priceToY(ln.price) + dPx);
      if (Number.isFinite(np) && np > 0) ln.price = np; else return;
    } else if (ln.type === 'hchannel') {
      const n1 = yToPrice(priceToY(ln.price1) + dPx), n2 = yToPrice(priceToY(ln.price2) + dPx);
      if (Number.isFinite(n1) && n1 > 0 && Number.isFinite(n2) && n2 > 0) { ln.price1 = n1; ln.price2 = n2; } else return;
    } else return;                        // 斜线/盈亏比不参与，避免误移
    e.preventDefault();
    draw(); scheduleSessionSave();
    return;
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (toolMode !== 'cursor') return;
  e.preventDefault();
  const len = dataLen();
  const plotW = canvas.clientWidth - PAD_L - PAD_R;
  const barsPerPx = viewCount / Math.max(1, plotW);
  const step = Math.max(1, Math.round(barsPerPx));    // 步进量随缩放自适应：缩放越小步进越大，避免桶边界跳动
  // 桶对齐：viewStart 量化到桶边界，确保每像素聚合的 K 线范围不变，柱子稳定不跳
  if (barsPerPx > 1) {
    const bkt = Math.max(1, Math.round(barsPerPx));
    viewStart = Math.round(Math.floor(viewStart / bkt) * bkt);
  }
  if (e.key === 'ArrowLeft') viewStart = Math.max(vsLo(), viewStart - step);
  else viewStart = Math.min(len - viewCount, viewStart + step);
  DS.ensure(Math.max(0, Math.floor(viewStart) - 200), Math.floor(viewStart) + viewCount);
  redrawSoon(); scheduleViewSave();
});

// 滚轮缩放（delta 累积 + 指数缩放 + rAF 节流）
// 解决 macOS 触控板缩放过于灵敏：高频小 delta 事件先累积，帧内一次性换算，
// 缩放幅度与滚动量成正比（连续可精细控制），而非每事件固定 15% 步进。
// §9 扩展：deltaX（触控板双指横向滑动）→ 平移视图（免按住拖拽，mac/win 兼容）。
// §14 缩放降速：1.15 -> 1.08（每格缩放幅度降至约 55%），越小心越钝
const ZOOM_SENSITIVITY = 1.08;  // 指数底数：一格标准滚动(120)的缩放倍数；越小越"钝"
const DELTA_NORM = 120;         // 鼠标一格的标准 delta，用于归一化触控板/鼠标
const ZOOM_MAX_PER_FRAME = 3;   // §14：单帧最大缩放格数（≈26% @1.08），超出部分丢弃（防触控板单帧暴冲）
let wheelAccum = 0;             // delta 累积器（像素归一化单位）
let panAccum = 0;               // deltaX 平移累积器（像素，与拖拽一致）
let wheelScheduled = false;     // rAF 是否已排程（节流）

// §18：viewStart 下限放开——最早一根可挪到屏幕最右（左侧留空）。
// 下限 = 1 - viewCount：此时右边缘 = viewStart+viewCount = 1，最早一根(idx 0)恰好在屏幕最右。
function vsLo() { return 1 - viewCount; }

function applyZoom(delta) {
  const len = dataLen();
  const plotW = canvas.clientWidth - PAD_L - PAD_R;
  // 连续指数缩放：delta=+1（向下滚一格）→ ×1.15（缩小视图，看到更多K线）；
  // delta=-1（向上滚一格）→ ×0.87（放大视图）。方向与原有语义保持一致。
  const factor = Math.pow(ZOOM_SENSITIVITY, delta);
  let nc = Math.round(viewCount * factor);
  nc = Math.max(20, Math.min(len, nc));
  // §17：缩放锚点分两种情形——
  //   1) 最新一根仍在屏内（当前右边缘已抵达末根 len）→ 钉住最新K线（贴右框、不露未来空白）；
  //   2) 已拖拽到历史区间（最新一根离开屏幕，curRight<len）→ 锚定「当前右边缘」，不再强行拉回最新根。
  const curRight = viewStart + viewCount;
  const rightEdge = (curRight >= len) ? len : curRight;
  viewCount = nc;
  // 在屏：viewStart=len-vc（最新贴右框）；离屏：viewStart=curRight-vc（停在历史位置）；缩到全量(vc=len)→vs=0 自动到底
  viewStart = Math.max(vsLo(), Math.min(len - viewCount, rightEdge - viewCount));
  // §12 桶对齐保护：量化 viewStart 到桶边界（防柱子跳），但仅在
  // 量化后右边缘**严格不变**时才采用（右侧贴框优先，偏差 0）。
  const bkt = Math.max(1, Math.round(viewCount / Math.max(1, plotW)));
  const vsQ = Math.round(Math.floor(viewStart / bkt) * bkt);
  if (Math.abs((vsQ + viewCount) - rightEdge) <= 1e-6) viewStart = vsQ;
  DS.ensure(Math.max(0, Math.floor(viewStart) - 200), Math.floor(viewStart) + viewCount);
  redrawSoon(); scheduleViewSave();
}

// 双指横向滑动平移（v1.3 方向修正：左滑=看更早=viewStart 减小）。
// 与拖拽平移同量纲（像素→K线：px / xW），符号相反：
//   deltaX<0（左滑）→ viewStart -= |px|/xW（看更早）
//   deltaX>0（右滑）→ viewStart += |px|/xW（看更近）
// §10 橡皮筋：到边界后继续拖，viewStart 保持边界值，剩余像素进入 panRubber
// （纯显示偏移，draw 时 translate），松手自动回弹。
const PAN_RUBBER_MAX = 90;      // 橡皮筋最大偏移（像素）
let panRubber = 0;              // 显示偏移（像素，正=内容右移）
let lastWheelAt = 0;            // 最近一次 wheel 时间戳（回弹判定）

function applyPan(px) {
  const len = dataLen();
  const plotW = canvas.clientWidth - PAD_L - PAD_R;
  const xW = plotW / viewCount;
  lastWheelAt = Date.now();

  let pxRemain = px; // 像素
  // 1) 往回拖时先抵消橡皮筋（方向相反则先"吃掉"）
  if (panRubber !== 0 && pxRemain !== 0 && Math.sign(pxRemain) !== Math.sign(panRubber)) {
    const absorb = Math.min(Math.abs(panRubber), Math.abs(pxRemain));
    panRubber -= Math.sign(panRubber) * absorb;
    pxRemain -= Math.sign(pxRemain) * absorb;
  }
  // 2) 剩余量移动 viewStart（仍 clamp 合法范围）
  const vs0 = viewStart;
  viewStart = Math.max(vsLo(), Math.min(len - viewCount, viewStart + pxRemain / xW));
  // 3) 被边界吃掉的量进橡皮筋（限幅）
  const leftoverPx = pxRemain - (viewStart - vs0) * xW;
  if (leftoverPx !== 0) {
    panRubber = Math.max(-PAN_RUBBER_MAX, Math.min(PAN_RUBBER_MAX, panRubber + leftoverPx));
  }
  DS.ensure(Math.max(0, Math.floor(viewStart) - 200), Math.floor(viewStart) + viewCount);
  redrawSoon(); scheduleViewSave();
}

// 橡皮筋回弹：wheel 停止 ≥120ms 后逐帧衰减 panRubber 至 0
function rubberBounce() {
  if (panRubber === 0) return;
  if (Date.now() - lastWheelAt < 120) return; // 还在拖动
  const next = panRubber * 0.85;
  panRubber = Math.abs(next) < 0.5 ? 0 : next;
  redrawSoon();
}

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  // 触控板：高频小 delta（像素）；鼠标：一格≈120。归一化后累积。
  wheelAccum += e.deltaY / DELTA_NORM;
  panAccum += e.deltaX;                       // 横向像素直接累积（与拖拽同量纲）
  if (wheelScheduled) return;                 // 帧内只排一次 rAF（节流）
  wheelScheduled = true;
  requestAnimationFrame(() => {
    wheelScheduled = false;
    let d = wheelAccum; wheelAccum = 0;     // 取帧内累积量
    const px = panAccum; panAccum = 0;
    // §14 单帧钳制：触控板猛滑/快速拨轮会在单帧累积多格，钳制避免视图瞬间翻倍。
    // 超出部分直接丢弃（不结转下一帧），避免松手后惯性继续缩放。
    d = Math.max(-ZOOM_MAX_PER_FRAME, Math.min(ZOOM_MAX_PER_FRAME, d));
    if (d !== 0) applyZoom(d);
    if (px !== 0) applyPan(px);
  });
}, { passive: false });

// 工具栏绑定
document.querySelectorAll('.symbols button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.symbols button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    setView(b.dataset.sym, null);
  });
});
document.querySelectorAll('.periods button').forEach(b => {
  b.addEventListener('click', () => {
    if (b.disabled) return;
    document.querySelectorAll('.periods button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    setView(null, b.dataset.p);
  });
});
document.querySelectorAll('.tools button[data-tool]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.tools button[data-tool]').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    toolMode = b.dataset.tool;
    selectedLine = null; drawingTrend = null; drawingMeasure = null; drawingChannel = null; drawingHChannel = null;
    canvas.style.cursor = 'crosshair';
  });
});
document.getElementById('clearLines').addEventListener('click', () => {
  lines = []; selectedLine = null; drawingTrend = null; drawingMeasure = null; drawingChannel = null; drawingHChannel = null;
  linesStore[lineKey()] = []; saveSessionNow(); draw();
});
// 盈亏比工具：开/关 + 多空方向 + 拖拽创建（按下定入场 → 拖出 TP/SL）
document.getElementById('tradeEnter').addEventListener('click', () => {
  tradeMode = !tradeMode;
  document.getElementById('tradeEnter').classList.toggle('trade-active', tradeMode);
  if (tradeMode) {
    const tp = getTradePlan();
    if (!tp) initTradePlan();
    else syncTradeDir(tp.dir);   // 让多/空切换与已载入规划的方向保持一致
  }
  draw(); scheduleSessionSave();
});
function syncTradeDir(dir) {
  document.querySelectorAll('#tradeDirSeg .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.dir === dir));
  const tp = getTradePlan();
  if (tp) {
    tp.dir = dir;
    // 方向与 TP/SL 位置矛盾时自动换位（多：TP>入场>SL；空：TP<入场<SL）
    if ((dir === 'long' && tp.tp < tp.sl) || (dir === 'short' && tp.tp > tp.sl)) {
      const t = tp.tp; tp.tp = tp.sl; tp.sl = t;
    }
    draw(); scheduleSessionSave();
  }
}
document.querySelectorAll('#tradeDirSeg .seg-btn').forEach(b => {
  b.addEventListener('click', () => syncTradeDir(b.dataset.dir));
});
// 重置刷新：清空全部记忆（所有周期的画线+浏览位置），回到最新K线
// ================= §27 工具条排序：按住拖动自定义顺序（顺序记忆到 localStorage） =================
// 两级：① 按住 .group-label 拖动 = 上下移动整个模块；② 按住「画线工具」组内的条目 = 调整工具顺序。
// 稳定键优先级：data-key > #id > data-tool。**新增按钮/模块时务必给它 data-key 或 id**，否则它不参与排序
// （会一直待在末尾）。测试 §27 会静态检查这一点。
const SORT_KEY = STORAGE_NS + 'kline_toolbar_order_v1';
let sortDefaults = null;      // 首次加载时的原始顺序，供「重置刷新」还原
let szDrag = null, szSwallow = false;

function toolbarRoot() { return document.getElementById('toolbar'); }
function szKey(el) {
  if (!el || !el.dataset) return null;
  return el.dataset.key || (el.id ? '#' + el.id : '') || (el.dataset.tool ? 'tool:' + el.dataset.tool : '') || null;
}
// 容器里「可排序的孩子」：容器中若有 .group 孩子 → 只排 .group（工具条根）；否则全部（画线工具组）
function szKids(box) {
  const all = [];
  for (let i = 0; i < box.children.length; i++) all.push(box.children[i]);
  const gs = all.filter(n => n.classList && n.classList.contains('group'));
  return gs.length ? gs : all;
}
function szToolsBox(root) { return root && root.querySelector ? root.querySelector('.group.tools') : null; }
function szOrderOf(root) {
  const o = { groups: szKids(root).map(szKey).filter(Boolean), items: {} };
  const t = szToolsBox(root);
  if (t) o.items.tools = szKids(t).map(szKey).filter(Boolean);
  return o;
}
function szApplyOrder(root, order) {
  if (!root || !order || !root.children) return;
  const put = (box, keys) => {
    if (!box || !Array.isArray(keys)) return;
    const map = {};
    szKids(box).forEach(n => { const k = szKey(n); if (k) map[k] = n; });
    const used = [];
    keys.forEach(k => { const n = map[k]; if (n && used.indexOf(k) < 0) { used.push(k); box.appendChild(n); } });
    // 记忆里没有的（新版本新增的模块/按钮）留在末尾，保持相对顺序
    szKids(box).forEach(n => { const k = szKey(n); if (k && used.indexOf(k) < 0) box.appendChild(n); });
  };
  put(root, order.groups);
  if (order.items) put(szToolsBox(root), order.items.tools);
}
// 把 el 拖到 y 处：找纵向最近的兄弟，落在它上半 → 插到它前面，下半 → 插到它后面
function szDropTarget(box, el, y) {
  const sibs = szKids(box).filter(n => n !== el);
  if (!sibs.length) return null;
  let best = null, bestD = Infinity;
  for (const n of sibs) {
    const r = n.getBoundingClientRect();
    const d = y < r.top ? (r.top - y) : (y > r.bottom ? (y - r.bottom) : 0);
    if (d < bestD) { bestD = d; best = n; }
  }
  const r = best.getBoundingClientRect();
  return { ref: best, after: y > r.top + r.height / 2 };
}
function szMoveTo(box, el, y) {
  const t = szDropTarget(box, el, y);
  if (!t) return false;
  const kids = szKids(box);
  const i = kids.indexOf(t.ref);
  const nextEl = t.after ? (kids[i + 1] || null) : t.ref;
  // 「插到 nextEl 之前」若 el 本来就紧挨在 nextEl 之前，等于没动 —— 必须判掉，
  // 否则鼠标停着不动也会反复 insertBefore（返回 true 让人误以为拖动了）。
  const curNext = kids[kids.indexOf(el) + 1] || null;
  if (el === nextEl || curNext === nextEl) return false;
  box.insertBefore(el, nextEl);
  return true;
}
function szSaveOrder(root) {
  const r = root || toolbarRoot();
  if (!r || !r.children) return;
  try { localStorage.setItem(SORT_KEY, JSON.stringify(szOrderOf(r))); } catch (e) {}
}
function szResetSort() {                            // 还原默认顺序并清掉记忆
  try { localStorage.removeItem(SORT_KEY); } catch (e) {}
  if (sortDefaults) szApplyOrder(toolbarRoot(), sortDefaults);
}
function szOnMove(e) {
  if (!szDrag) return;
  if (!szDrag.on) {
    if (Math.abs(e.clientY - szDrag.y) < 5 && Math.abs(e.clientX - szDrag.x) < 5) return;   // 小抖动不算拖
    szDrag.on = true;
    szDrag.el.classList.add('sz-drag');
    if (document.body) document.body.classList.add('sz-sorting');
  }
  e.preventDefault();
  if (szMoveTo(szDrag.box, szDrag.el, e.clientY)) szDrag.moved = true;
}
function szOnUp() {
  if (!szDrag) return;
  window.removeEventListener('mousemove', szOnMove, true);
  window.removeEventListener('mouseup', szOnUp, true);
  if (szDrag.on) {
    szDrag.el.classList.remove('sz-drag');
    if (document.body) document.body.classList.remove('sz-sorting');
    // ⚠️ 只有「真的换过位置」才落盘 + 吞掉紧随的 click。
    // 否则：想点「水平线」时手抖 6px 会被判成拖拽，click 被吞 → 工具点不动，看起来像坏了。
    if (!szDrag.moved) { szDrag = null; return; }
    szSaveOrder();
    // 吞掉紧随其后那一次 click：否则「拖完 连画」会顺手把复选框点掉、拖完工具会把工具切了
    szSwallow = true;
    // 只吞紧随的那一次：浏览器在 mouseup 后几乎立刻派发 click，200ms 足够；
    // 窗口太长会把用户拖完顺手点的别的按钮也吃掉。
    setTimeout(() => { szSwallow = false; }, 200);
  }
  szDrag = null;
}
function initSort() {
  const root = toolbarRoot();
  if (!root || !root.children) return;               // 无工具条（或非浏览器环境）直接跳过
  sortDefaults = szOrderOf(root);                    // 先记原始顺序，再套用用户保存的顺序
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SORT_KEY) || 'null'); } catch (e) {}
  if (saved) szApplyOrder(root, saved);
  if (root.querySelectorAll) root.querySelectorAll('.group-label').forEach(l => {
    const g = l.parentElement;
    l.title = (g && g.classList.contains('tools'))
      ? '按住拖动：上下移动「画线工具」模块；按住下面任一工具可调整工具顺序'
      : '按住拖动：上下移动这个模块';
  });
  window.addEventListener('click', e => {
    if (szSwallow) { szSwallow = false; e.stopPropagation(); e.preventDefault(); }
  }, true);
  root.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    let el = null, box = null;
    const lbl = e.target.closest ? e.target.closest('.group-label') : null;
    if (lbl && lbl.parentElement && lbl.parentElement.parentElement === root) {
      el = lbl.parentElement; box = root;                       // ① 抓标签 = 移动整个模块
    } else {
      const t = szToolsBox(root);
      if (t && t.contains(e.target)) {
        if (e.target.closest && e.target.closest('input, select, textarea')) return;   // 输入控件不参与拖动
        let n = e.target;
        while (n && n !== t && n.parentElement !== t) n = n.parentElement;
        if (n && n.parentElement === t && szKey(n)) { el = n; box = t; }               // ② 抓组内条目 = 排工具顺序
      }
    }
    if (!el) return;
    szDrag = { el, box, x: e.clientX, y: e.clientY, on: false, moved: false };
    window.addEventListener('mousemove', szOnMove, true);
    window.addEventListener('mouseup', szOnUp, true);
  });
}
initSort();

document.getElementById('resetSession').addEventListener('click', () => {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  szResetSort();   // §27 连同工具条排序一起还原默认
  linesStore = {}; viewStore = {}; lines = []; selectedLine = null; drawingTrend = null; drawingMeasure = null; drawingChannel = null; drawingHChannel = null;
  RESTORE = null;
  const len = dataLen();
  viewCount = Math.min(260, len);
  viewStart = Math.max(vsLo(), len - viewCount);
  DS.ensure(Math.max(0, Math.floor(viewStart) - 200), Math.floor(viewStart) + viewCount);
  draw();
});
['ema20', 'ema120'].forEach(id => document.getElementById(id).addEventListener('change', () => { savePrefs(); draw(); }));
document.getElementById('contDraw').addEventListener('change', e => { continuousDraw = e.target.checked; });
document.getElementById('logscale').addEventListener('change', e => { logScale = e.target.checked; savePrefs(); draw(); });
document.getElementById('keepTime').addEventListener('change', e => { keepCursorTime = e.target.checked; savePrefs(); });
// 交割单导入 / 标注
document.getElementById('importTrades').addEventListener('click', () => document.getElementById('tradeFile').click());
document.getElementById('tradeFile').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  if (f) importTradesFile(f);
  e.target.value = '';
});
document.getElementById('showTrades').addEventListener('change', e => { showTrades = e.target.checked; draw(); });
document.getElementById('clearTrades').addEventListener('click', () => {
  tradesBySym = {}; resolvedMarks = []; for (const k in marksCache) delete marksCache[k];
  try { localStorage.removeItem(TRADES_KEY); } catch (e) {}
  setTradeInfo('已清除交割单');
  draw();
});
document.getElementById('hintClose').addEventListener('click', () => { document.getElementById('hint').style.display = 'none'; });

window.addEventListener('resize', resize);
loadPrefs();
loadSession();
loadTrades();
loadSim();
wireSim();
focusInit();
if (Object.keys(tradesBySym).length) {
  const total = Object.values(tradesBySym).reduce((a, b) => a + b.length, 0);
  setTradeInfo(`已载入 ${total} 笔交割单（点击「清除交割单」可移除）`);
}
// 若有上次会话则恢复到上次的标的+周期，否则默认 BTC 日线
const START_SYM = (RESTORE && SYMBOLS[RESTORE.sym]) ? RESTORE.sym : 'BTC';
const START_PERIOD = RESTORE ? RESTORE.period : '1d';
document.querySelectorAll('.symbols button').forEach(x => x.classList.remove('active'));
(document.querySelector(`.symbols button[data-sym="${START_SYM}"]`) ||
 document.querySelector('.symbols button[data-sym="BTC"]')).classList.add('active');
resize();
setView(START_SYM, START_PERIOD);
