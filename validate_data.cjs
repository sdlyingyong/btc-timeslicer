#!/usr/bin/env node
// btc-timeslicer 数据完整性校验（GitHub Actions 调用）
// 设计原则：
//   - 只拦截“真损坏”，保证每日自动更新不会因为 OKX 偶发缺一根而整体失败。
//   - 致命(退出码1)：数据段缺失 / JSON 解析失败 / 任一周期时间戳非递增(重复或乱序) / 任一周期为空。
//   - 非致命(仅警告，不阻断推送)：网格缺口(gap)或时间戳不对齐(mis)——真实交易所数据偶尔会缺一根。
'use strict';
const fs = require('fs');

const HTML = 'index.html';
const h = fs.readFileSync(HTML, 'utf8');
const m = h.match(/window\.BTCFUT_DATA\s*=\s*(\{[\s\S]*?\})\s*;/);
if (!m) { console.error('[FAIL] 未找到 window.BTCFUT_DATA'); process.exit(1); }

let D;
try {
  D = JSON.parse(m[1]);
} catch (e) {
  console.error('[FAIL] BTCFUT_DATA JSON 解析失败:', e.message);
  process.exit(1);
}

const grid = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
let critical = false;

for (const k of Object.keys(grid)) {
  const a = D[k];
  const g = grid[k];
  if (!Array.isArray(a) || a.length === 0) {
    console.error(`[FAIL] ${k} 为空（数据损坏）`);
    critical = true;
    continue;
  }
  let inc = true, gap = 0, mis = 0;
  for (let i = 1; i < a.length; i++) {
    if (a[i][0] <= a[i - 1][0]) inc = false;        // 非严格递增 = 重复或乱序 = 损坏
    if (a[i][0] - a[i - 1][0] !== g) gap++;          // 网格缺口（允许少量，仅警告）
    if (a[i][0] % g !== 0) mis++;                    // 时间戳不对齐（1d 由4h派生应恒为0）
  }
  const last = new Date(a[a.length - 1][0] * 60000).toISOString();
  console.log(`${k} n=${a.length} gap=${gap} mis=${mis} inc=${inc} last=${last}`);
  if (!inc) {
    console.error(`[FAIL] ${k} 存在非递增时间戳（疑似重复/乱序，数据损坏）`);
    critical = true;
  }
  if (mis > 0) {
    console.warn(`[WARN] ${k} 有 ${mis} 根时间戳不对齐，请检查（1d 应为0）`);
  }
  if (gap > 0) {
    console.warn(`[WARN] ${k} 有 ${gap} 处网格缺口，将照常推送`);
  }
}

// ---- 量能口径校验：滚动均值不得出现 >20 倍台阶（致命，阻断推送）----
// 背景：OKX 蜡烛第 6 字节 vol 是「张」，第 7 字节 volCcy 才是「币」；BTC-USDT-SWAP 的 ctVal=0.01。
//       一旦误存 vol，追加段量能会比历史段（BTC 口径）大 100 倍 —— 图上表现为「半屏柱子看不见、
//       半屏顶满」，而且任何归一化策略都救不回来。正常行情下历史最大台阶仅约 2.9 倍
//       （2020-03 疫情崩盘 / 2021-05 崩盘），20 倍阈值既能拦住口径事故又不会误伤真实行情。
const WIN = { '15m': 2000, '1h': 500, '4h': 200, '1d': 60 };
let maxStep = 0, maxStepAt = '', maxStepPer = '';
for (const k of Object.keys(grid)) {
  const a = D[k];
  if (!Array.isArray(a) || a.length < 8) continue;
  const win = Math.min(WIN[k], Math.max(1, Math.floor(a.length / 4)));
  if (a.length <= win * 2) continue;
  const P = new Float64Array(a.length + 1);
  for (let i = 0; i < a.length; i++) P[i + 1] = P[i] + (+a[i][5] || 0);
  for (let i = win; i < a.length - win; i++) {
    const before = (P[i] - P[i - win]) / win;
    const after = (P[i + win] - P[i]) / win;
    if (before <= 0 || after <= 0) continue;
    const r = after / before;
    if (r > maxStep) { maxStep = r; maxStepAt = new Date(a[i][0] * 60000).toISOString(); maxStepPer = k; }
  }
}
console.log(`量能口径检查: 最大台阶 ×${maxStep.toFixed(2)} @ ${maxStepAt} (${maxStepPer}, 阈值 20)`);
if (maxStep > 20) {
  console.error(`[FAIL] ${maxStepPer} 在 ${maxStepAt} 附近出现 ×${maxStep.toFixed(1)} 量能台阶（阈值 20）：` +
    '疑似成交量单位口径不一致（OKX vol=张 / volCcy=币，见 update_data.cjs 的 CT_VAL 注释）');
  critical = true;
}

if (critical) {
  console.error('数据完整性校验失败，拒绝提交');
  process.exit(1);
}
console.log('数据校验通过（缺口/错位仅作警告，不阻断推送）');
