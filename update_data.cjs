#!/usr/bin/env node
// btc-timeslicer 数据更新脚本（OKX BTC-USDT 永续合约）
// 仅重写 index.html 里的 window.BTCFUT_DATA 数据段，代码逻辑原样保留。
// 用法:
//   本地(走代理): HTTPS_PROXY=http://127.0.0.1:10809 node update_data.cjs
//   云端/直连(无需代理): node update_data.cjs   # 不设 HTTPS_PROXY 即直连 OKX
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = __dirname;
const HTML = path.join(REPO, 'index.html');
// 仅在显式设置 HTTPS_PROXY/HTTP_PROXY 时才走代理；否则直连（云端 runner 适用）
const USE_PROXY = !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
const PROXY = USE_PROXY ? (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) : '';
const INST = 'BTC-USDT-SWAP';
// ⚠️ 单位陷阱：OKX 蜡烛第 6 字节 vol 是「张数」，BTC-USDT-SWAP 的 ctVal=0.01 BTC，1 张=0.01 BTC；
//    第 7 字节 volCcy 才是「币本位数量」（BTC）。
//    本仓库历史段（来自 k--data / 币安 K 线）量能单位是 BTC，所以必须存 volCcy。
//    2026-08 曾误存 vol（张），导致 2026-08-24 起量能比历史段大 100 倍
//    （图表上表现为「一半柱子看不见、另一半顶满」），已修正。
const CT_VAL = 0.01;          // 兜底：volCcy 缺失时用 vol × ctVal 换算
const LIMIT = 100;            // OKX candles 单页最大 100
const PERIODS = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
const SLEEP_MS = 150;         // 翻页间隔，避免触发 OKX 限频

function fetchJson(url, attempt = 0) {
  const MAX = 3;
  try {
    const px = USE_PROXY ? `-x ${PROXY} ` : '';
    const out = execSync(`curl -s -m 30 ${px}"${url}"`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (e) {
    if (attempt < MAX - 1) {
      const wait = 1000 * (attempt + 1);
      console.warn(`fetch 失败 (${e.message || e}); ${wait}ms 后重试 ${attempt + 1}/${MAX - 1}`);
      sleep(wait);
      return fetchJson(url, attempt + 1);
    }
    throw e;
  }
}
const sleep = ms => execSync(`sleep ${ms / 1000}`);

// ---- 读取现有数据 ----
const html = fs.readFileSync(HTML, 'utf8');
const m = html.match(/window\.BTCFUT_DATA\s*=\s*(\{[\s\S]*?\})\s*;/);
if (!m) { console.error('未找到 window.BTCFUT_DATA'); process.exit(2); }
const data = JSON.parse(m[1]);

let totalAdded = 0, totalReplaced = 0;

// 从 4h 重聚合 00:00 UTC 日线（OKX 1D 锚定 16:00 UTC，直接抓会与历史 00:00 UTC 网格错位）
function deriveDailyFrom4h(data) {
  const h4 = data['4h'];
  const d1 = data['1d'];
  const lastDay = d1.length ? Math.floor(d1[d1.length - 1][0] / 1440) * 1440 : 0;
  const byDay = new Map();
  for (const b of h4) {
    const day = Math.floor(b[0] / 1440) * 1440;
    if (day <= lastDay) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(b);
  }
  const seen = new Map();
  for (let i = 0; i < d1.length; i++) seen.set(d1[i][0], i);
  let added = 0;
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const bars = byDay.get(day).slice().sort((a, b) => a[0] - b[0]);
    const o = bars[0][1];
    const c = bars[bars.length - 1][4];
    const hi = bars.reduce((m, x) => Math.max(m, x[2]), -Infinity);
    const lo = bars.reduce((m, x) => Math.min(m, x[3]), Infinity);
    const v = bars.reduce((s, x) => s + x[5], 0);
    const bar = [day, o, hi, lo, c, v];
    if (seen.has(day)) d1[seen.get(day)] = bar;
    else { d1.push(bar); seen.set(day, d1.length - 1); added++; }
  }
  d1.sort((a, b) => a[0] - b[0]);
  console.log(`1d: 从4h派生 +${added} 天, 现 ${d1.length} 根, 末端=${new Date(d1[d1.length - 1][0] * 60000).toISOString()}`);
  return added;
}

for (const p of ['15m', '1h', '4h']) {
  const arr = data[p];
  if (!Array.isArray(arr) || arr.length === 0) { console.log(`${p}: 跳过（无数据）`); continue; }
  const lastTs = arr[arr.length - 1][0];        // 分钟
  const barOkx = PERIODS[p];

  // 从最新往回翻页，直到越过已有末端
  const cols = [];                              // OKX 原始蜡烛（最新在前）
  let after = null, pages = 0;
  while (pages < 80) {
    let url = `https://www.okx.com/api/v5/market/candles?instId=${INST}&bar=${barOkx}&limit=${LIMIT}`;
    if (after) url += `&after=${after}`;
    const j = fetchJson(url);
    if (j.code !== '0' || !Array.isArray(j.data) || j.data.length === 0) break;
    for (const c of j.data) cols.push(c);
    const oldestMs = Number(j.data[j.data.length - 1][0]);
    pages++;
    if (oldestMs <= lastTs * 60000) break;       // 已抵达/越过已有末端
    after = oldestMs;
    sleep(SLEEP_MS);
  }

  // ts(分钟)->已有位置映射，用于刷新最后一根 + 去重
  const seen = new Map();
  for (let i = 0; i < arr.length; i++) seen.set(arr[i][0], i);

  let added = 0, replaced = 0;
  for (let i = cols.length - 1; i >= 0; i--) {   // 由旧到新
    const c = cols[i];
    const tsMin = Math.floor(Number(c[0]) / 60000);
    if (tsMin < lastTs) continue;                // 仅处理末端之后的
    // 量能统一取 volCcy（币本位/BTC），与历史段（币安 K 线的 BTC 口径）一致
    const volCcy = c[6] === undefined || c[6] === null || c[6] === '' ? NaN : +c[6];
    const vol = Number.isFinite(volCcy) ? Math.round(volCcy * 1e6) / 1e6
                                        : Math.round(+c[5] * CT_VAL * 1e6) / 1e6;
    const bar = [tsMin, +c[1], +c[2], +c[3], +c[4], vol];
    if (seen.has(tsMin)) { arr[seen.get(tsMin)] = bar; replaced++; }
    else { arr.push(bar); seen.set(tsMin, arr.length - 1); added++; }
  }
  arr.sort((a, b) => a[0] - b[0]);
  console.log(`${p}: +${added} 新柱, 刷新 ${replaced} 根(最后一根), 现 ${arr.length} 根, 末端=${(new Date(arr[arr.length - 1][0] * 60000).toISOString())}`);
  totalAdded += added; totalReplaced += replaced;
}

// 1d 由 4h 重聚合（见 deriveDailyFrom4h），不从 OKX 直接抓，避免 16:00 UTC 网格错位
totalAdded += deriveDailyFrom4h(data);

console.log(`合计: 新增 ${totalAdded} 根, 刷新 ${totalReplaced} 根`);

if (totalAdded + totalReplaced === 0) {
  console.log('无新数据，index.html 未改动');
  process.exit(0);
}

const newData = JSON.stringify(data);
const lastD1 = data['1d'][data['1d'].length - 1];
const stamp = new Date(lastD1[0] * 60000).toISOString().slice(0, 10);
const newHtml = html
  .replace(/window\.BTCFUT_DATA\s*=\s*(\{[\s\S]*?\})\s*;/, 'window.BTCFUT_DATA=' + newData + ';')
  .replace(/window\.BTCFUT_UPDATED\s*=\s*"[^"]*";/, 'window.BTCFUT_UPDATED="' + stamp + '";');
fs.writeFileSync(HTML, newHtml);
console.log('index.html 已重写数据段，BTCFUT_UPDATED=' + stamp);
