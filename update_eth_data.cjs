#!/usr/bin/env node
// §33 ETH 尾部增量：把 share/eth/ 的分片末端补齐到「现在」（OKX ETH-USDT-SWAP 15m）
//
// 为什么需要它：历史分片来自 kline-timemachine 仓库，其 last 是**快照**（构建时为 2026-07-28）。
// 读图时若分片末端距今超过 REST 首屏能覆盖的 3.1 天（300 根 15m），图上就会出现一段真实存在的**空洞**。
// 本脚本按 OKX 公开行情把这段补齐 —— 与 BTC 的 update_data.cjs 完全同构：
//   历史段 = 外部仓库（不可变） / 尾部 = OKX（每次运行向前推进）
//
// 边界（硬约束）：
//   · 只追加 **ts > 分片末根** 的柱子，绝不改写历史段（沿用 sync_from_kdata.cjs「历史段不被篡改」的原则）
//   · 只写入 **已收盘（confirm==='1'）** 的柱子 —— 分片是历史资产，未收盘那根交给前端的 REST/WS
//   · 第一页取不到数据 → **显式 exit 1**，绝不静默当成「没有新数据」（§32 的教训）
//   · 只碰 share/eth/**，BTC 路径一行不动
//
// 用法：
//   HTTPS_PROXY=http://127.0.0.1:10809 node update_eth_data.cjs
//   node update_eth_data.cjs --check      # 只报告会新增多少，不写盘
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const B = require('./build_eth_shards.cjs');

const REPO = __dirname;
const INST = 'ETH-USDT-SWAP';
const LIMIT = 300;                  // OKX 单页上限（history-candles 实测也吃 300）
const SLEEP_MS = 150;               // 翻页间隔，避免触发限频
const MAX_PAGES = 200;              // 200 × 300 × 15m ≈ 171 天，足够覆盖任何正常的断更间隔
const VOL_STEP_MAX = 20;

const CHECK_ONLY = process.argv.includes('--check');
const USE_PROXY = !!(process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
const PROXY = USE_PROXY ? (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) : '';

const sleep = ms => execSync(`sleep ${ms / 1000}`);
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

// OKX 原始蜡烛 → 内部格式。⚠️ 量能取第 7 列（索引 6）volCcy＝「币」，不是第 6 列 vol＝「张」
//    ETH-USDT-SWAP ctVal=0.1，两者恒差 10 倍；混用就是 §32 那笔 100 倍事故的复发。
function parseOkx(rows) {
  const out = [];
  for (const c of rows) {
    if (!Array.isArray(c) || c.length < 7) continue;
    if (String(c[8]) !== '1') continue;                    // 只要已收盘的
    const ts = Math.floor(+c[0] / 60000), o = +c[1], h = +c[2], l = +c[3], cl = +c[4], v = +c[6];
    if (![ts, o, h, l, cl, v].every(Number.isFinite)) continue;
    out.push([ts, o, h, l, cl, B.r6(v)]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

function fetchTail(lastTs) {
  const cols = [];
  let after = null, pages = 0, ep = 'candles', prevOldest = Infinity;
  while (pages < MAX_PAGES) {
    let url = `https://www.okx.com/api/v5/market/${ep}?instId=${INST}&bar=15m&limit=${LIMIT}`;
    if (after) url += `&after=${after}`;
    const j = fetchJson(url);
    const rows = (j && j.code === '0' && Array.isArray(j.data)) ? j.data : [];
    if (rows.length === 0) {
      if (ep === 'candles') { ep = 'history-candles'; continue; }   // 快照端点到底 → 换历史端点，不计页
      if (pages === 0) {
        console.error(`[FAIL] OKX 两个端点都没取到 ETH 数据（code=${j && j.code} msg=${j && j.msg}）。` +
          '这不是「没有新数据」，而是取数失败（地域限制/限频/被墙）—— 拒绝静默通过。');
        process.exit(1);
      }
      break;
    }
    for (const c of rows) cols.push(c);
    const oldest = Number(rows[rows.length - 1][0]);
    pages++;
    if (oldest <= lastTs * 60000) break;                          // 已够到分片末端
    if (oldest >= prevOldest) {                                    // after 未被端点采纳 → 防止死循环
      console.warn(`端点 ${ep} 未推进（oldest 未变小），停止翻页`);
      break;
    }
    prevOldest = oldest;
    if (rows.length < LIMIT && ep === 'candles') {
      ep = 'history-candles';
      console.log(`market/candles 已到底，改用 history-candles 继续回补（目标末端 ${B.iso(lastTs)}）`);
    }
    after = oldest;
    sleep(SLEEP_MS);
  }
  console.log(`翻页 ${pages} 页，共取回 ${cols.length} 根原始蜡烛`);
  return parseOkx(cols);
}

function main() {
  const got = B.loadShardsFromDisk();
  if (!got) { console.error('[FAIL] 未找到 share/eth/manifest.js —— 请先跑 node build_eth_shards.cjs'); process.exit(1); }
  const { manifest, periods } = got;
  const k15 = periods['15m'];
  const lastTs = k15[k15.length - 1][0];
  console.log(`当前分片：${manifest.years.length} 片 / ${k15.length} 根 15m / 末根 ${B.iso(lastTs)} / 源 ${manifest.src}`);

  const tail = fetchTail(lastTs);
  if (!tail.length) { console.error('[FAIL] OKX 返回 0 根可用蜡烛 —— 取数失败，拒绝静默通过。'); process.exit(1); }

  const fresh = tail.filter(b => b[0] > lastTs);      // 只追加更晚的；历史段一根不改
  console.log(`OKX 可用 ${tail.length} 根，其中晚于分片末端 ${fresh.length} 根` +
    (fresh.length ? `（${B.iso(fresh[0][0])} → ${B.iso(fresh[fresh.length - 1][0])}）` : ''));
  if (!fresh.length) { console.log('无新数据，share/eth/ 未改动'); process.exit(0); }

  // 缺口体检：新增段内部是否连续（源仓库与 OKX 之间允许 1 根衔接差，因为分片末端本身是源快照）
  let gap = 0, gapAt = -1;
  for (let i = 1; i < fresh.length; i++) if (fresh[i][0] - fresh[i - 1][0] !== 15) { gap++; if (gapAt < 0) gapAt = i; }
  if (fresh[0][0] - lastTs !== 15) console.log(`注意：接缝处跨 ${(fresh[0][0] - lastTs) / 1440 | 0} 天（源快照与 OKX 之间），属预期`);
  if (gap) console.warn(`新增段内有 ${gap} 处网格缺口（首处 ${gapAt >= 0 ? B.iso(fresh[gapAt][0]) : '-'}），照常写入`);

  const merged = k15.concat(fresh);
  merged.sort((a, b) => a[0] - b[0]);
  let inc = true;
  for (let i = 1; i < merged.length; i++) if (merged[i][0] <= merged[i - 1][0]) { inc = false; break; }
  if (!inc) { console.error('[FAIL] 合并后 15m 时间戳非严格递增，拒绝写入'); process.exit(1); }

  const periods2 = B.derivePeriods(merged);
  const { years, counts, total } = B.splitYears(periods2);

  // 量能口径守门（合并后再查一次：OKX 用的是 volCcy 还是 vol，这里能立刻暴露）
  let maxStep = 0, maxStepAt = 0;
  const WIN = { '15m': 2000, '1h': 500, '4h': 200, '1d': 60 };
  for (const p of B.PERIODS) {
    const a = periods2[p];
    const win = Math.min(WIN[p], Math.max(1, Math.floor(a.length / 4)));
    if (a.length <= win * 2) continue;
    const P = new Float64Array(a.length + 1);
    for (let i = 0; i < a.length; i++) P[i + 1] = P[i] + (+a[i][5] || 0);
    for (let i = win; i < a.length - win; i++) {
      const before = (P[i] - P[i - win]) / win, after = (P[i + win] - P[i]) / win;
      if (before <= 0 || after <= 0) continue;
      if (after / before > maxStep) { maxStep = after / before; maxStepAt = a[i][0]; }
    }
  }
  console.log(`量能口径检查: 最大台阶 ×${maxStep.toFixed(2)} @ ${B.iso(maxStepAt)} (阈值 ${VOL_STEP_MAX})`);
  if (maxStep > VOL_STEP_MAX) {
    console.error(`[FAIL] 量能出现 ×${maxStep.toFixed(1)} 台阶，疑似成交量单位口径不一致（volCcy/vol 混用），拒绝写入`);
    process.exit(1);
  }

  if (CHECK_ONLY) {
    console.log(`(--check 未写盘) 将新增 ${fresh.length} 根 15m，分片末端推进到 ${B.iso(merged[merged.length - 1][0])}，共 ${years.length} 年`);
    process.exit(0);
  }

  B.writeAll(periods2, years, counts, total);
  console.log(`\nshare/eth/ 已更新：15m ${k15.length} → ${merged.length}（+${fresh.length}），末端 ${B.iso(merged[merged.length - 1][0])}`);
}

main();
