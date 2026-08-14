// 从 k--data 仓库同步最新 BTC K 线到 btc-timeslicer/index.html
// 用法: node sync_from_kdata.cjs [--repo=../k--data] [--remote] [--no-write]
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = process.cwd();
const SCRIPT_DIR = __dirname;
const HTML = path.join(SCRIPT_DIR, 'index.html');
const KDATA = process.argv.find(a => a.startsWith('--repo='))?.slice(7) || path.join(SCRIPT_DIR, '..', 'k--data');
const REMOTE = process.argv.includes('--remote');
const NO_WRITE = process.argv.includes('--no-write');
const KH = path.join(KDATA, 'btc_fut_data.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name + (extra ? '  [' + extra + ']' : '')); }
  else { fail++; console.log('FAIL  ' + name + (extra ? '  [' + extra + ']' : '')); }
}

function tMinFromStr(s) {
  // "YYYY-MM-DD HH:MM:SS" (UTC) -> 分钟 epoch
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) throw new Error('bad ts: ' + s);
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 60000);
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

function ensureRepo() {
  if (REMOTE && fs.existsSync(KDATA)) {
    console.log('updating existing repo at', KDATA);
    try { execSync('git -C "' + KDATA + '" pull --ff-only', { stdio: 'inherit', shell: true }); } catch (e) { console.log('git pull failed:', e.message); }
    return;
  }
  if (!fs.existsSync(KDATA)) {
    console.log('cloning k--data into', KDATA);
    const cmd = 'git clone --depth 1 https://github.com/sdlyingyong/k--data.git "' + KDATA + '"';
    try { execSync(cmd, { stdio: 'inherit', shell: true }); }
    catch (e) {
      console.log('direct clone failed, trying gh-proxy mirror...');
      execSync('git clone --depth 1 https://gh-proxy.com/https://github.com/sdlyingyong/k--data.git "' + KDATA + '"', { stdio: 'inherit', shell: true });
    }
  } else {
    console.log('using existing local repo at', KDATA, '(git pull 可更新)');
  }
}

function main() {
  if (!NO_WRITE) ensureRepo();
  if (!fs.existsSync(KH)) { console.error('k--data repo not found at ' + KDATA); process.exit(1); }

  // ---- 1. 读取 k--data ----
  const js = fs.readFileSync(KH, 'utf8');
  const kd = JSON.parse(js.match(/\{[\s\S]*\}/)[0]);
  const meta15 = kd['15m'];
  if (!meta15.__chunked) throw new Error('15m 应为分块索引');
  const chunks = [];
  for (let i = 0; i < meta15.chunks; i++) {
    const f = path.join(KDATA, 'fut_data', 'btc_15m_' + String(i).padStart(4, '0') + '.json');
    chunks.push(...JSON.parse(fs.readFileSync(f, 'utf8')));
  }
  check('15m 分块数量', meta15.chunks === 13, 'chunks=' + meta15.chunks);
  check('15m 总根数', chunks.length === meta15.total, chunks.length + ' vs ' + meta15.total);

  // ---- 2. 转换 ----
  const k15 = chunks.map(r => [tMinFromStr(r[0]), +r[1], +r[2], +r[3], +r[4], +r[5]]);
  check('15m 末根时间', k15[k15.length - 1][0] === tMinFromStr(meta15.last),
    new Date(k15[k15.length - 1][0] * 60000).toISOString());

  // ---- 3. 重采样 ----
  const newData = {
    '15m': k15,
    '1h': resample15(k15, 60),
    '4h': resample15(k15, 240),
    '1d': resample15(k15, 1440)
  };

  // ---- 4. 校验 ----
  // 4a. 与 k--data 内联数组容差对比：H/L/C 逐根相对误差<=1%（O 跳过——k--data 15m 为「前收O」惯例，
  //     其 1h/4h/1d 内联为币安真实开盘价，定义不同属源数据固有差异）；V 允许少量修复点
  for (const [p, step] of [['1h', 60], ['4h', 240], ['1d', 1440]]) {
    const mine = newData[p], theirs = kd[p];
    let n = 0, bad = 0, badV = 0;
    for (let i = 0; i < mine.length && i < theirs.length; i++) {
      const a = mine[i], b = theirs[i];
      if (a[0] !== tMinFromStr(b[0])) continue;
      n++;
      for (const f of [2, 3, 4]) {
        if (Math.abs(a[f] - b[f]) > Math.max(1e-6, Math.abs(b[f]) * 0.01)) { bad++; break; }
      }
      if (Math.abs(a[5] - b[5]) > Math.max(1e-6, Math.abs(b[5]) * 0.01)) badV++;
    }
    check(p + ' 重采样 vs k--data 内联（H/L/C<=1%）', bad <= 3 && n > 0,
      '对比' + n + '根, H/L/C超差=' + bad + ', V超差=' + badV);
  }
  // 4b. 15m 时间连续
  let cont = true, gapAt = -1;
  for (let i = 1; i < k15.length; i++) {
    if (k15[i][0] - k15[i - 1][0] !== 15) { cont = false; gapAt = i; break; }
  }
  check('15m 时间连续（间隔=15）', cont, gapAt >= 0 ? 'gap@' + gapAt + ' ' + new Date(k15[gapAt][0] * 60000).toISOString() : '');
  // 4c. 各周期严格递增、无重复
  for (const p of ['15m', '1h', '4h', '1d']) {
    const a = newData[p];
    let mono = true;
    for (let i = 1; i < a.length; i++) if (a[i][0] <= a[i - 1][0]) { mono = false; break; }
    check(p + ' 时间戳严格递增', mono);
  }
  // 4d. 历史段（旧数据全长）不被篡改——四周期逐根对比（1h/4h/1d 旧末根为占位 stub，允许差异）
  if (!NO_WRITE) {
    const oldHtml = fs.readFileSync(HTML, 'utf8');
    const oldData = JSON.parse(oldHtml.match(/window\.BTCFUT_DATA=(\{.*?\});<\/script>/s)[1]);
    const checkHist = (p, allowLast) => {
      const a = oldData[p], b = newData[p];
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
    checkHist('15m', false);
    checkHist('1h', true);
    checkHist('4h', true);
    checkHist('1d', true);
  }
  // 4e. 新增量
  if (!NO_WRITE) {
    const oldHtml = fs.readFileSync(HTML, 'utf8');
    const oldLen = JSON.parse(oldHtml.match(/window\.BTCFUT_DATA=(\{.*?\});<\/script>/s)[1])['15m'].length;
    console.log('\n增量: 15m +' + (k15.length - oldLen) + ' 根（' + oldLen + ' → ' + k15.length + '），截止 ' + new Date(k15[k15.length - 1][0] * 60000).toISOString());
  } else {
    console.log('\n(仅校验，未写入) 15m 共 ' + k15.length + ' 根');
  }

  if (fail) { console.log('\n校验未通过，不写入。'); process.exit(1); }

  // ---- 5. 重建 index.html ----
  if (!NO_WRITE) {
    const html = fs.readFileSync(HTML, 'utf8');
    const patched = html.replace(/window\.BTCFUT_DATA=(\{.*?\});<\/script>/s,
      'window.BTCFUT_DATA=' + JSON.stringify(newData) + ';</script>');
    fs.writeFileSync(HTML, patched);
    console.log('wrote index.html (' + Math.round(patched.length / 1048576) + 'MB)');
  }
  console.log('\n校验结果: ' + pass + ' PASS / ' + fail + ' FAIL');
}

main();
