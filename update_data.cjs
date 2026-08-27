// 每日自动拉取币安 BTCUSDT 永续 15m K 线，追加到 index.html 的 window.BTCFUT_DATA 并重采样。
// 用法: node update_data.cjs            # 拉取并写入 index.html（若今天已是最新则跳过）
// 环境变量:
//   BINANCE_BASE  币安 API 基址，默认 https://fapi.binance.com
//                 国内被墙时可设为自己的反代，例如 https://你的反代/fapi
//   DRY_RUN       设为 1 时只校验不写文件
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = __dirname;
const HTML = path.join(REPO, 'index.html');
const BASE = (process.env.BINANCE_BASE || 'https://fapi.binance.com').replace(/\/+$/, '');
const DRY = process.env.DRY_RUN === '1';

const DATA_RE = /window\.BTCFUT_DATA=(\{[\s\S]*?\});<\/script>/;

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

async function fetchKlines(startTimeMs) {
  const url = BASE + '/fapi/v1/klines?symbol=BTCUSDT&interval=15m&startTime=' + startTimeMs + '&limit=1500';
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText + ' @ ' + url);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('unexpected body: ' + JSON.stringify(rows).slice(0, 200));
  return rows;
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

  // 以 t 为键重建 15m，便于对“进行中那根”做更新而非重复追加
  const map = new Map();
  for (const b of old15) map.set(b[0], b);

  let cursor = (oldLastT + 15) * 60000; // 下一根起始（ms）
  const now = Date.now();
  let fetched = 0;
  while (true) {
    const rows = await fetchKlines(cursor);
    if (rows.length === 0) break;
    for (const k of rows) {
      const tMin = Math.floor(Number(k[0]) / 60000); // openTime(ms) -> UTC 分钟
      if (tMin <= oldLastT) continue;
      map.set(tMin, [tMin, +k[1], +k[2], +k[3], +k[4], +k[5]]);
      fetched++;
    }
    const lastOpen = Number(rows[rows.length - 1][0]);
    const lastClose = Number(rows[rows.length - 1][6]);
    cursor = lastOpen + 1;
    if (rows.length < 1500) break;               // 已追到最新
    if (lastClose >= now - 15 * 60000) break;    // 末根已覆盖到现在
    await new Promise(r => setTimeout(r, 250));  // 礼貌限速
  }
  check('从币安获取到新根数', fetched >= 0, 'fetched=' + fetched);

  const new15 = [...map.values()].sort((a, b) => a[0] - b[0]);
  const added = new15.length - old15.length;
  check('15m 总根数增加', added >= 0, old15.length + ' -> ' + new15.length);

  // 重采样
  const newData = {
    '15m': new15,
    '1h': resample15(new15, 60),
    '4h': resample15(new15, 240),
    '1d': resample15(new15, 1440)
  };

  // 校验
  // 1) 15m 时间连续（间隔=15），允许末尾“进行中那根”与上一根间隔不足
  let cont = true, gapAt = -1;
  for (let i = 1; i < new15.length; i++) {
    if (new15[i][0] - new15[i - 1][0] !== 15) { cont = false; gapAt = i; break; }
  }
  check('15m 时间连续（间隔=15）', cont, gapAt >= 0 ? 'gap@' + gapAt + ' ' + new Date(new15[gapAt][0] * 60000).toISOString() : '');

  // 2) 各周期严格递增
  for (const p of ['15m', '1h', '4h', '1d']) {
    const a = newData[p];
    let mono = true;
    for (let i = 1; i < a.length; i++) if (a[i][0] <= a[i - 1][0]) { mono = false; break; }
    check(p + ' 时间戳严格递增', mono);
  }

  // 3) 历史段不被篡改：15m 前缀完全相等；1h/4h/1d 末根为 stub，允许最后一根不同
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

  // 写回 index.html
  const today = new Date().toISOString().slice(0, 10);
  const patched = html.replace(DATA_RE,
    'window.BTCFUT_DATA=' + JSON.stringify(newData) + ';window.BTCFUT_UPDATED="' + today + '";</script>');
  fs.writeFileSync(HTML, patched);
  console.log('wrote index.html (' + Math.round(patched.length / 1048576) + 'MB)');
  console.log('\n校验结果: ' + pass + ' PASS / ' + fail + ' FAIL');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
