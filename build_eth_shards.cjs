#!/usr/bin/env node
// §33 ETH 全量历史 → 按 UTC 自然年分片（share/eth/YYYY.js + share/eth/manifest.js）
//
// 数据源：用户**已有**的 GitHub 仓库 sdlyingyong/kline-timemachine（默认分支 main）
//   fut_data/eth_15m_0000..0011.json  → 12 块 / 233,730 根 15m  ← 唯一必需源
//   data/eth_fut_data.js              → 索引；其 1h/4h/1d 内联数组**仅用于交叉校验**
//   ⚠️ 不抓 OKX，也不用 sync_from_kdata.cjs 里那个**已 404** 的 k--data 仓库。
//   ⚠️ 不取 eth_5m_*.json（66.7MB）—— 本工具只有 15m/1h/4h/1d 四个周期。
//
// 口径（详见 PRD §33.3）：
//   源行 = [tsStr(UTC), o, h, l, c, vol_币, vol_USDT, 涨跌幅%, ""]
//   目标 = [tsMin, o, h, l, c, vol_币]
//     · tsStr 按 **UTC** 解析（已用「重采样 vs 源内联，根数完全一致」交叉验证）
//     · 量能取**第 6 列（币本位 ETH）**，不是第 7 列 USDT 成交额
//       —— 这是 §32 那笔 100 倍量能事故的同一条铁律
//     · 1h/4h/1d 一律由 15m resample15 派生，**1d 锚定 UTC 00:00**
//
// 用法：
//   HTTPS_PROXY=http://127.0.0.1:10809 node build_eth_shards.cjs   # 联网取源（国内必须走代理）
//   node build_eth_shards.cjs --src=/tmp/eth_src                   # 用已下载的源目录
//   node build_eth_shards.cjs --check                              # 只校验已产出分片，不联网不写盘
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = __dirname;
const OUT_DIR = path.join(REPO, 'share', 'eth');

const argOf = k => {
  const a = process.argv.find(x => x.startsWith('--' + k + '='));
  return a ? a.slice(k.length + 3) : null;
};
const CHECK_ONLY = process.argv.includes('--check');
const SRC_DIR = argOf('src') || path.join(REPO, '.eth_src');
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';

const GH = 'https://raw.githubusercontent.com/sdlyingyong/kline-timemachine/main';
const SRC_REPO = 'sdlyingyong/kline-timemachine@main';
const N_CHUNKS = 12;
const EXPECT_TOTAL = 233730;
const PERIODS = ['15m', '1h', '4h', '1d'];
const STEP = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };
// 量能滚动台阶阈值：正常行情历史最大台阶约 2.9 倍（2020-03 崩盘 / 2021-05 崩盘），
// 20 倍既能拦住「币 / 张 / USDT 额」口径混用，又不会误伤真实行情。
const VOL_STEP_MAX = 20;
const SRC_TS_BAD_MAX = 3;      // 与 sync_from_kdata.cjs 同源的容差：H/L/C 超差 ≤ 3 根

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
  return !!cond;
}
const iso = tMin => (tMin === undefined || tMin === null) ? '--' : new Date(tMin * 60000).toISOString().replace('.000Z', 'Z');

// "YYYY-MM-DD HH:MM:SS" (UTC) -> 分钟 epoch（与 sync_from_kdata.cjs 的 tMinFromStr 同义，独立实现在此）
function tMinFromStr(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error('bad ts: ' + s);
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 60000);
}
const r6 = v => Math.round(v * 1e6) / 1e6;

// 15m -> step 分钟重采样（开取首根 O、末根 C、极值、量能求和；slot 向下取整 = UTC 网格）
function resample15(bars, step) {
  const out = [];
  for (const b of bars) {
    const slot = Math.floor(b[0] / step) * step;
    const last = out[out.length - 1];
    if (!last || last[0] !== slot) out.push([slot, b[1], b[2], b[3], b[4], b[5]]);
    else { last[2] = Math.max(last[2], b[2]); last[3] = Math.min(last[3], b[3]); last[4] = b[4]; last[5] = last[5] + b[5]; }
  }
  return out;
}
const utcYear = tMin => new Date(tMin * 60000).getUTCFullYear();

// ---------- 源：下载 / 载入 ----------

function grab(rel, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return;
  const px = PROXY ? `-x ${PROXY} ` : '';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  execSync(`curl -sS -f -m 300 ${px}-o "${tmp}" "${GH}/${rel}"`, { stdio: ['ignore', 'ignore', 'pipe'] });
  fs.renameSync(tmp, dest);
  console.log(`  ↓ ${rel}  ${(fs.statSync(dest).size / 1048576).toFixed(2)}MB`);
}

// 探活：源仓库必须可达，否则显式失败 —— 绝不产出半成品（源已改名/迁移过一次，见 PRD §33.2）
function probeRemote() {
  const px = PROXY ? `-x ${PROXY} ` : '';
  const out = execSync(`curl -sS -f -m 60 ${px}"${GH}/fut_data/eth_15m_0000.json" -r 0-64`, { encoding: 'utf8' });
  if (!/^\[\["?\d{4}-\d{2}-\d{2} /.test(out)) throw new Error('源仓库探活失败（返回内容不是预期 K 线 JSON）');
  console.log('源仓库探活 OK：' + SRC_REPO);
}

function ensureSource() {
  if (fs.existsSync(path.join(SRC_DIR, 'eth_15m_0011.json'))) {
    console.log('使用本地源目录 ' + SRC_DIR);
    return;
  }
  probeRemote();
  for (let i = 0; i < N_CHUNKS; i++) grab('fut_data/eth_15m_' + String(i).padStart(4, '0') + '.json',
    path.join(SRC_DIR, 'eth_15m_' + String(i).padStart(4, '0') + '.json'));
  try { grab('data/eth_fut_data.js', path.join(SRC_DIR, 'index.js')); } catch (e) { console.warn('索引下载失败（仅影响交叉校验）:' + e.message); }
}

function loadSrcRows() {
  const rows = [];
  for (let i = 0; i < N_CHUNKS; i++) {
    const f = path.join(SRC_DIR, 'eth_15m_' + String(i).padStart(4, '0') + '.json');
    if (!fs.existsSync(f)) throw new Error('缺少源分块：' + f);
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(arr)) throw new Error('源分块不是数组：' + f);
    for (const r of arr) rows.push(r);
  }
  return rows;
}
function loadSrcIndex() {
  const f = path.join(SRC_DIR, 'index.js');
  if (!fs.existsSync(f)) return null;
  const m = /window\.ETHFUT_DATA\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(fs.readFileSync(f, 'utf8'));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

// ---------- 构建 ----------

// 返回 { periods:{p:[…]}, years:[…], counts:{y:{p:n}}, total:{p:n} }
function buildPeriods(rows) {
  check('源分块行数', rows.length === EXPECT_TOTAL, rows.length + ' vs ' + EXPECT_TOTAL);
  check('源行皆为 9 列', rows.every(r => Array.isArray(r) && r.length === 9));

  const k15 = rows.map(r => [tMinFromStr(r[0]), +r[1], +r[2], +r[3], +r[4], r6(+r[5])]);

  // 15m 连续性 / 递增 / 网格对齐
  let cont = true, gapAt = -1;
  for (let i = 1; i < k15.length; i++) if (k15[i][0] - k15[i - 1][0] !== 15) { cont = false; gapAt = i; break; }
  check('15m 时间连续（间隔恒 15）', cont, gapAt >= 0 ? 'gap@' + gapAt + ' ' + iso(k15[gapAt][0]) : k15.length + ' 根');
  check('15m 对齐 15 分钟网格', k15.every(b => b[0] % 15 === 0));
  check('15m OHLC 全为有限正数',
    k15.every(b => [b[1], b[2], b[3], b[4]].every(v => Number.isFinite(v) && v > 0)));
  check('15m 量能非负有限', k15.every(b => Number.isFinite(b[5]) && b[5] >= 0));

  const periods = derivePeriods(k15);

  for (const p of PERIODS) {
    const a = periods[p];
    let inc = true;
    for (let i = 1; i < a.length; i++) if (a[i][0] <= a[i - 1][0]) { inc = false; break; }
    check(p + ' 时间戳严格递增', inc, 'n=' + a.length);
  }
  check('1d 全部锚定 UTC 00:00', periods['1d'].every(b => b[0] % 1440 === 0));

  // 量能口径：滚动均值的最大台阶
  let maxStep = 0, maxStepAt = 0, maxStepPer = '';
  const WIN = { '15m': 2000, '1h': 500, '4h': 200, '1d': 60 };
  for (const p of PERIODS) {
    const a = periods[p];
    const win = Math.min(WIN[p], Math.max(1, Math.floor(a.length / 4)));
    if (a.length <= win * 2) continue;
    const P = new Float64Array(a.length + 1);
    for (let i = 0; i < a.length; i++) P[i + 1] = P[i] + (+a[i][5] || 0);
    for (let i = win; i < a.length - win; i++) {
      const before = (P[i] - P[i - win]) / win, after = (P[i + win] - P[i]) / win;
      if (before <= 0 || after <= 0) continue;
      const r = after / before;
      if (r > maxStep) { maxStep = r; maxStepAt = a[i][0]; maxStepPer = p; }
    }
  }
  check('量能口径（滚动台阶 < ' + VOL_STEP_MAX + '）', maxStep < VOL_STEP_MAX,
    '×' + maxStep.toFixed(2) + ' @ ' + iso(maxStepAt) + ' (' + maxStepPer + ')');

  // 与源索引的内联 1h/4h/1d 交叉校验（证明 UTC 口径与重采样实现都对）
  const idx = loadSrcIndex();
  if (idx) {
    for (const p of ['1h', '4h', '1d']) {
      const theirs = idx[p];
      if (!Array.isArray(theirs) || !theirs.length) continue;
      const sm = new Map(theirs.map(r => [tMinFromStr(r[0]), r]));
      let n = 0, bad = 0, badV = 0;
      for (const a of periods[p]) {
        const b = sm.get(a[0]);
        if (!b) continue;
        n++;
        for (const f of [2, 3, 4]) {
          if (Math.abs(a[f] - +b[f]) > Math.max(1e-6, Math.abs(+b[f]) * 0.01)) { bad++; break; }
        }
        if (Math.abs(a[5] - +b[5]) > Math.max(1e-6, Math.abs(+b[5]) * 0.01)) badV++;
      }
      check(p + ' 重采样 vs 源索引内联（H/L/C≤1%）', n > 0 && bad <= SRC_TS_BAD_MAX,
        '对比' + n + '根, 超差=' + bad + ', V超差=' + badV + '（源n=' + theirs.length + '）');
    }
  } else {
    console.log('SKIP  源索引交叉校验（无 index.js）');
  }

  const { years, counts, total } = splitYears(periods);

  // 分片自身完整性：每年四周期非空；年份归属不串（首末根都落在该年）
  let yearOk = true, yearBad = '';
  for (const y of years) {
    for (const p of PERIODS) if (!counts[y][p]) { yearOk = false; yearBad = y + '/' + p + ' 为空'; }
  }
  check('每年四周期皆非空', yearOk, years.length + ' 年' + (yearBad ? ' —— ' + yearBad : ''));

  return { periods, years, counts, total };
}

// 按 UTC 自然年切分统计（build_eth_shards 与 update_eth_data 共用）
function splitYears(periods) {
  const years = [...new Set(periods['15m'].map(b => utcYear(b[0])))].sort((a, b) => a - b);
  const counts = {};
  for (const y of years) counts[y] = {};
  for (const p of PERIODS) {
    for (const b of periods[p]) counts[utcYear(b[0])][p] = (counts[utcYear(b[0])][p] || 0) + 1;
  }
  const total = {};
  for (const p of PERIODS) total[p] = periods[p].length;
  return { years, counts, total };
}

// 由 15m 派生四周期（唯一权威入口：两套脚本都走这里，避免出现第二套网格口径）
function derivePeriods(k15) {
  return { '15m': k15, '1h': resample15(k15, 60), '4h': resample15(k15, 240), '1d': resample15(k15, 1440) };
}

// 跨片连续性：上年末根 + step === 下年首根（证明「按年切」没切丢、没重叠）
function checkCrossYear(periods, years) {
  for (const p of PERIODS) {
    const byYear = new Map();
    for (const b of periods[p]) {
      const y = utcYear(b[0]);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(b);
    }
    let ok = true, why = '';
    for (let i = 1; i < years.length; i++) {
      const prev = byYear.get(years[i - 1]), cur = byYear.get(years[i]);
      if (!prev || !cur) continue;
      const a = prev[prev.length - 1][0], b = cur[0][0];
      if (b - a !== STEP[p]) { ok = false; why = years[i - 1] + '末' + iso(a) + ' → ' + years[i] + '首' + iso(b) + ' 差' + (b - a) + '≠' + STEP[p]; break; }
    }
    check(p + ' 跨年无缝（上年末+step == 下年首）', ok, why || (years.length - 1) + ' 处衔接');
  }
}

// ---------- 写盘 ----------

function shardBody(year, periods) {
  const o = {};
  for (const p of PERIODS) o[p] = periods[p].filter(b => utcYear(b[0]) === year).map(b => [b[0], b[1], b[2], b[3], b[4], r6(b[5])]);
  return JSON.stringify(o);
}
function writeAll(periods, years, counts, total) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const files = [];
  for (const y of years) {
    const body = shardBody(y, periods);
    const txt = 'window.ETHFUT_SHARDS=window.ETHFUT_SHARDS||{};\n' +
      'window.ETHFUT_SHARDS[' + y + ']=' + body + ';\n';
    const f = path.join(OUT_DIR, y + '.js');
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    if (old !== txt) { fs.writeFileSync(f, txt); }
    files.push({ y, bytes: Buffer.byteLength(txt), changed: old !== txt });
  }
  const manifest = {
    sym: 'ETH', inst: 'ETH-USDT-SWAP', ctVal: 0.1,
    src: SRC_REPO,
    first: iso(periods['15m'][0][0]), last: iso(periods['15m'][periods['15m'].length - 1][0]),
    years: years, counts: counts, total: total,
    builtAt: new Date().toISOString().slice(0, 10)
  };
  const mTxt = 'window.ETHFUT_MANIFEST=' + JSON.stringify(manifest) + ';\n';
  const mf = path.join(OUT_DIR, 'manifest.js');
  const mOld = fs.existsSync(mf) ? fs.readFileSync(mf, 'utf8') : null;
  if (mOld !== mTxt) fs.writeFileSync(mf, mTxt);

  console.log('\n--- share/eth/ 产出 ---');
  let sum = 0;
  for (const f of files) { sum += f.bytes; console.log(`  ${f.y}.js  ${(f.bytes / 1048576).toFixed(2)}MB  ${f.changed ? '（写入）' : '（未变）'}  n15m=${counts[f.y]['15m']}`); }
  console.log(`  manifest.js  ${Buffer.byteLength(mTxt)}B`);
  console.log(`  合计 ${(sum / 1048576).toFixed(2)}MB / ${files.length} 片`);

  // 强不变量：源 15m 无缺口 ⇒ 每个被覆盖的网格槽位**恰好一根**，根数必须等于槽位数。
  // （比「15m/16」这类近似式严谨：首尾不满桶时近似式恒偏小 1~2）
  const slots = step => Math.floor(periods['15m'][periods['15m'].length - 1][0] / step)
                      - Math.floor(periods['15m'][0][0] / step) + 1;
  for (const p of ['1h', '4h', '1d']) {
    check('产出 ' + p + ' 根数 == 覆盖槽位数', periods[p].length === slots(STEP[p]),
      periods[p].length + ' vs ' + slots(STEP[p]));
  }
}

// ---------- --check：只读已产出分片，重跑全部数据体检 ----------

function loadShardsFromDisk() {
  const mf = path.join(OUT_DIR, 'manifest.js');
  if (!fs.existsSync(mf)) return null;
  const mm = /window\.ETHFUT_MANIFEST\s*=\s*(\{[\s\S]*\})\s*;/.exec(fs.readFileSync(mf, 'utf8'));
  if (!mm) return null;
  const manifest = JSON.parse(mm[1]);
  const periods = { '15m': [], '1h': [], '4h': [], '1d': [] };
  for (const y of manifest.years) {
    const f = path.join(OUT_DIR, y + '.js');
    if (!fs.existsSync(f)) throw new Error('缺少分片 ' + f);
    const m = new RegExp('window\\.ETHFUT_SHARDS\\[' + y + '\\]\\s*=\\s*(\\{[\\s\\S]*\\})\\s*;').exec(fs.readFileSync(f, 'utf8'));
    if (!m) throw new Error('分片解析失败 ' + f);
    const o = JSON.parse(m[1]);
    for (const p of PERIODS) { if (!Array.isArray(o[p])) throw new Error(f + ' 缺周期 ' + p); periods[p] = periods[p].concat(o[p]); }
  }
  for (const p of PERIODS) periods[p].sort((a, b) => a[0] - b[0]);
  return { manifest, periods };
}

function runChecksOnPeriods(periods, manifest) {
  for (const p of PERIODS) {
    const a = periods[p];
    check(p + ' 非空', Array.isArray(a) && a.length > 0, 'n=' + (a ? a.length : 0));
    let inc = true;
    for (let i = 1; i < a.length; i++) if (a[i][0] <= a[i - 1][0]) { inc = false; break; }
    check(p + ' 时间戳严格递增', inc);
    let grid = true;
    for (let i = 1; i < a.length; i++) if (a[i][0] - a[i - 1][0] !== STEP[p]) { grid = false; break; }
    check(p + ' 网格间隔恒 ' + STEP[p], grid);
    if (manifest) {
      const want = manifest.total[p];
      check(p + ' 总根数与 manifest 一致', a.length === want, a.length + ' vs ' + want);
    }
  }
  const years = manifest ? manifest.years : [...new Set(periods['15m'].map(b => utcYear(b[0])))].sort((a, b) => a - b);
  checkCrossYear(periods, years);
}

// ---------- main ----------

function main() {
  if (CHECK_ONLY) {
    const got = loadShardsFromDisk();
    if (!got) { console.error('[FAIL] 未找到 share/eth/manifest.js —— 请先跑 node build_eth_shards.cjs'); process.exit(1); }
    console.log('校验已产出分片：' + got.manifest.years.length + ' 片 / ' + got.manifest.src);
    runChecksOnPeriods(got.periods, got.manifest);
    console.log('\n校验结果: ' + pass + ' PASS / ' + fail + ' FAIL');
    process.exit(fail ? 1 : 0);
  }

  ensureSource();
  const rows = loadSrcRows();
  const { periods, years, counts, total } = buildPeriods(rows);
  checkCrossYear(periods, years);
  check('年份数 ≥ 7', years.length >= 7, years.join(','));
  check('首根 = 2019-11-27 07:45 UTC', periods['15m'][0][0] === tMinFromStr('2019-11-27 07:45:00'), iso(periods['15m'][0][0]));
  check('末根 = 2026-07-28 00:00 UTC', periods['15m'][periods['15m'].length - 1][0] === tMinFromStr('2026-07-28 00:00:00'), iso(periods['15m'][periods['15m'].length - 1][0]));

  if (fail) { console.error('\n校验未通过，不写盘。'); process.exit(1); }
  writeAll(periods, years, counts, total);
  console.log('\n构建结果: ' + pass + ' PASS / ' + fail + ' FAIL');
}

if (require.main === module) main();
module.exports = {
  tMinFromStr, resample15, derivePeriods, buildPeriods, checkCrossYear, splitYears,
  loadShardsFromDisk, writeAll, utcYear, r6, iso,
  PERIODS, STEP, OUT_DIR, SRC_REPO
};
