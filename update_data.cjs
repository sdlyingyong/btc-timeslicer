#!/usr/bin/env node
// btc-timeslicer 数据更新脚本（OKX BTC-USDT 永续合约）
// 仅重写 index.html 里的 window.BTCFUT_DATA 数据段，代码逻辑原样保留。
// 用法: HTTPS_PROXY=http://127.0.0.1:10809 node update_data.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = __dirname;
const HTML = path.join(REPO, 'index.html');
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'http://127.0.0.1:10809';
const INST = 'BTC-USDT-SWAP';
const LIMIT = 100;            // OKX candles 单页最大 100
const PERIODS = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
const SLEEP_MS = 150;         // 翻页间隔，避免触发 OKX 限频

function fetchJson(url) {
  const out = execSync(`curl -s -m 30 -x ${PROXY} "${url}"`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}
const sleep = ms => execSync(`sleep ${ms / 1000}`);

// ---- 读取现有数据 ----
const html = fs.readFileSync(HTML, 'utf8');
const m = html.match(/window\.BTCFUT_DATA\s*=\s*(\{[\s\S]*?\})\s*;/);
if (!m) { console.error('未找到 window.BTCFUT_DATA'); process.exit(2); }
const data = JSON.parse(m[1]);

let totalAdded = 0, totalReplaced = 0;

for (const p of ['15m', '1h', '4h', '1d']) {
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
    const bar = [tsMin, +c[1], +c[2], +c[3], +c[4], +c[5]]; // ts,o,h,l,c,vol(合约数)
    if (seen.has(tsMin)) { arr[seen.get(tsMin)] = bar; replaced++; }
    else { arr.push(bar); seen.set(tsMin, arr.length - 1); added++; }
  }
  arr.sort((a, b) => a[0] - b[0]);
  console.log(`${p}: +${added} 新柱, 刷新 ${replaced} 根(最后一根), 现 ${arr.length} 根, 末端=${(new Date(arr[arr.length - 1][0] * 60000).toISOString())}`);
  totalAdded += added; totalReplaced += replaced;
}

console.log(`合计: 新增 ${totalAdded} 根, 刷新 ${totalReplaced} 根`);

if (totalAdded + totalReplaced === 0) {
  console.log('无新数据，index.html 未改动');
  process.exit(0);
}

const newData = JSON.stringify(data);
const newHtml = html.replace(/window\.BTCFUT_DATA\s*=\s*(\{[\s\S]*?\})\s*;/, 'window.BTCFUT_DATA=' + newData + ';');
fs.writeFileSync(HTML, newHtml);
console.log('index.html 已重写数据段');
