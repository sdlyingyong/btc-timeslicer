// 每日自动拉取 BTC 永续 15m K 线，追加到 index.html 的 window.BTCFUT_DATA 并重采样。
// 用法: node update_data.cjs
// 环境变量:
//   SOURCE       数据源: okx (默认, 国内可直连) | binance (需区域合规反代)
//   BINANCE_BASE 仅 binance 用，API 基址，默认 https://fapi.binance.com
//   HTTPS_PROXY  网络代理，默认尝试本机 127.0.0.1:10809
//   DRY_RUN      设为 1 时只校验不写文件
// 让 Node 的 fetch 走代理（Node24 需启动时设置 NODE_USE_ENV_PROXY，故必要时自重启）
if (process.env.NODE_USE_ENV_PROXY !== '1') {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10809';
    process.env.HTTP_PROXY = 'http://127.0.0.1:10809';
  }
  process.env.NODE_USE_ENV_PROXY = '1';
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: process.env });
  process.exit(r.status == null ? 1 : r.status);
}

const fs = require('fs');
const path = require('path');

const REPO = __dirname;
const HTML = path.join(REPO, 'index.html');
const SOURCE = (process.env.SOURCE || 'okx').toLowerCase();
const DRY = process.env.DRY_RUN === '1';
const BINANCE_BASE = (process.env.BINANCE_BASE || 'https://fapi.binance.com').replace(/\/+$/, '');

const DATA_RE = /window\.BTCFUT_DATA=(\{[\s\S]*?\})(?:;window\.BTCFUT_UPDATED="[^"]*")?;<\/script>/;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

function resample15(bars, step) {
  const out = [];
  for (const b of bars) {
    const slot = Math.floor(b[0] / step) * step;
    const last = out[out.length - 1];
    if (!last || last[0] !== slot) out.push([slot, b[1], b[2], b[3], b[4], b[5]]);
    else { last[2] = Math.max(last[2], b[2]); last[3] = Math.min(last[3], b[3]); last[4] = b[4]; last[5] += b[5]; }
  }
  return out;
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' @ ' + url);
  return res.json();
}

// 返回 [{tMin, o,h,l,c,v}, ...]（升序），仅含 tMin > oldLastT 的新增根
async function fetchNew(source, oldLastT) {
  const map = new Map();
  let fetched = 0;

  if (source === 'binance') {
    let cursor = (oldLastT + 15) * 60000; // 下一根起始（ms）
    const now = Date.now();
    while (true) {
      const url = BINANCE_BASE + '/fapi/v1/klines?symbol=BTCUSDT&interval=15m&startTime=' + cursor + '&limit=1500';
      const rows = await fetchJson(url);
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const k of rows) {
        const tMin = Math.floor(Number(k[0]) / 60000);
        if (tMin <= oldLastT) continue;
        map.set(tMin, [tMin, +k[1], +k[2], +k[3], +k[4], +k[5]]);
        fetched++;
      }
      const lastClose = Number(rows[rows.length - 1][6]);
      cursor = Number(rows[rows.length - 1][0]) + 1;
      if (rows.length < 1500) break;
      if (lastClose >= now - 15 * 60000) break;
      await sleep(250);
    }
  } else if (source === 'okx') {
    const instId = 'BTC-USDT-SWAP';
    const base = 'https://www.okx.com/api/v5/market/history-candles?instId=' + instId + '&bar=15m&limit=100';
    const boundary = (oldLastT + 15) * 60000;
    let after = null;
    while (true) {
      const url = after ? base + '&after=' + after : base;
      const body = await fetchJson(url);
      const rows = body && body.data;
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) {
        const tMin = Math.floor(Number(r[0]) / 60000); // ts(ms)
        if (tMin <= oldLastT) continue;
        map.set(tMin, [tMin, +r[1], +r[2], +r[3], +r[4], +r[5]]); // vol=合约数, 近似 base 量
        fetched++;
      }
      const oldestTs = Number(rows[rows.length - 1][0]);
      if (oldestTs <= boundary) break;
      after = oldestTs;
      await sleep(200);
    }
  } else {
    throw new Error('未知 SOURCE=' + source);
  }
  return { bars: [...map.values()].sort((a, b) => a[0] - b[0]), fetched };
}

async function main() {
  const html = fs.readFileSync(HTML, 'utf8');
  const m = html.match(DATA_RE);
  if (!m) { console.error('找不到 window.BTCFUT_DATA 赋值'); process.exit(1); }
  const old = JSON.parse(m[1]);
  for (const p of ['15m', '1h', '4h', '1d']) {
    if (!Array.isArray(old[p])) { console.error('缺少周期 ' + p); process.exit(1); }
  }

  const old15 = old['15m'];
  const oldLastT = old15[old15.length - 1][0];
  console.log('数据源=' + SOURCE + '  现有 15m 末根=' + new Date(oldLastT * 60000).toISOString() + '  共 ' + old15.length + ' 根');

  const { bars: inc, fetched } = await fetchNew(SOURCE, oldLastT);
  check('获取到新根数', fetched >= 0, 'fetched=' + fetched);

  // 合并（以 t 为键，支持更新进行中那根）
  const map = new Map(old15.map(b => [b[0], b]));
  for (const b of inc) map.set(b[0], b);
  const new15 = [...map.values()].sort((a, b) => a[0] - b[0]);
  const added = new15.length - old15.length;
  check('15m 总根数增加', added >= 0, old15.length + ' -> ' + new15.length);

  const newData = {
    '15m': new15,
    '1h': resample15(new15, 60),
    '4h': resample15(new15, 240),
    '1d': resample15(new15, 1440)
  };

  // 校验
  let cont = true, gapAt = -1;
  for (let i = 1; i < new15.length; i++) {
    if (new15[i][0] - new15[i - 1][0] !== 15) { cont = false; gapAt = i; break; }
  }
  check('15m 时间连续（间隔=15）', cont, gapAt >= 0 ? 'gap@' + gapAt + ' ' + new Date(new15[gapAt][0] * 60000).toISOString() : '');

  for (const p of ['15m', '1h', '4h', '1d']) {
    const a = newData[p];
    let mono = true;
    for (let i = 1; i < a.length; i++) if (a[i][0] <= a[i - 1][0]) { mono = false; break; }
    check(p + ' 时间戳严格递增', mono);
  }

  const histCheck = (p, allowLast) => {
    const a = old[p], b = newData[p];
    const n = allowLast ? a.length - 1 : a.length;
    let same = b.length >= a.length, firstDiff = -1;
    for (let i = 0; same && i < n; i++) {
      if (a[i][0] !== b[i][0] || Math.abs(a[i][1] - b[i][1]) > 1e-6 || Math.abs(a[i][2] - b[i][2]) > 1e-6 ||
          Math.abs(a[i][3] - b[i][3]) > 1e-6 || Math.abs(a[i][4] - b[i][4]) > 1e-6 || Math.abs(a[i][5] - b[i][5]) > 1e-6) {
        same = false; firstDiff = i;
      }
    }
    check('历史段 ' + p + ' 未被篡改' + (allowLast ? '（末根 stub 除外）' : ''), same, firstDiff >= 0 ? 'diff@' + firstDiff : n + ' bars');
  };
  histCheck('15m', false);
  histCheck('1h', true);
  histCheck('4h', true);
  histCheck('1d', true);

  if (fail) { console.log('\n校验未通过，不写入。'); process.exit(1); }
  if (added === 0) { console.log('\n已是最新，无需更新。'); console.log('校验结果: ' + pass + ' PASS / ' + fail + ' FAIL'); process.exit(0); }

  console.log('\n增量: 15m +' + added + ' 根，截止 ' + new Date(new15[new15.length - 1][0] * 60000).toISOString());

  if (DRY) { console.log('(DRY_RUN 不写文件)'); console.log('校验结果: ' + pass + ' PASS / ' + fail + ' FAIL'); process.exit(0); }

  const today = new Date().toISOString().slice(0, 10);
  const patched = html.replace(DATA_RE,
    'window.BTCFUT_DATA=' + JSON.stringify(newData) + ';window.BTCFUT_UPDATED="' + today + '";</script>');
  fs.writeFileSync(HTML, patched);
  console.log('wrote index.html (' + Math.round(patched.length / 1048576) + 'MB)');
  console.log('\n校验结果: ' + pass + ' PASS / ' + fail + ' FAIL');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
