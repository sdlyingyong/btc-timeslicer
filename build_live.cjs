#!/usr/bin/env node
// 从「复盘」入口 index.html 生成其余入口壳 —— 单一源，避免多份代码漂移。
//
// 每个派生入口与源文件的差异只有 3 处（其余完全一致，连 CSS/画布代码都不复制）：
//   1) 实例标记   window.__APP_INSTANCE__ = 'review' → 'live' / 'watch'
//                （决定 localStorage/IndexedDB 前缀，各入口进度互不干扰）
//   2) 资源路径   src="share/…" → src="../share/…"   （多一层目录）
//   3) 页面标题   BTC 时光机 · 复盘 → … · 看盘 / … · 自选
//
// 入口清单（§32 起为三个）：
//   index.html        复盘（源，手改这一个）           __APP_INSTANCE__='review'
//   live/index.html   看盘（每 5 分钟 REST 自动补数）   __APP_INSTANCE__='live'
//   watch/index.html  自选（多币种 + WebSocket 实时）   __APP_INSTANCE__='watch'
//
// 用法：node build_live.cjs          （正常流程；数据在 share/，与本文件无关）
//      node build_live.cjs --check  （只校验派生壳是否与 index.html 同步，不写盘；测试用）
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = __dirname;
const SRC = path.join(REPO, 'index.html');

const SRC_MARK = "window.__APP_INSTANCE__='review'";
const SRC_TITLE = '<title>BTC 时光机 · 复盘</title>';

// §32：入口由「一个」泛化为「一张表」——加新入口只需在这里加一行
const ENTRIES = [
  { dir: 'live', instance: 'live', title: '<title>BTC 时光机 · 看盘</title>' },
  { dir: 'watch', instance: 'watch', title: '<title>BTC 时光机 · 自选</title>' }
];

function buildEntry(src, instance) {
  const e = ENTRIES.filter(x => x.instance === instance)[0];
  if (!e) throw new Error('build_live: 未知入口 ' + JSON.stringify(instance));
  if (src.indexOf(SRC_MARK) < 0) throw new Error('build_live: 源文件缺少实例标记 ' + JSON.stringify(SRC_MARK));
  if (src.indexOf(SRC_TITLE) < 0) throw new Error('build_live: 源文件缺少标题 ' + JSON.stringify(SRC_TITLE));
  let out = src.split(SRC_MARK).join("window.__APP_INSTANCE__='" + e.instance + "'");
  out = out.split(SRC_TITLE).join(e.title);
  // 资源路径：share/xxx → ../share/xxx（只动 src=" 后面那一段）
  out = out.replace(/(src=")share\//g, '$1../share/');
  if (!/src="\.\.\/share\/app\.js"/.test(out)) throw new Error('build_live: 资源路径替换失败');
  if (out.indexOf("window.__APP_INSTANCE__='" + e.instance + "'") < 0) throw new Error('build_live: 实例标记替换失败');
  return out;
}

// 兼容旧签名：buildLive(src) === buildEntry(src, 'live')（§30 起测试依赖它）
function buildLive(src) { return buildEntry(src, 'live'); }

function outPathOf(e) { return path.join(REPO, e.dir, 'index.html'); }

function main() {
  const checkOnly = process.argv.includes('--check');
  const src = fs.readFileSync(SRC, 'utf8');

  if (checkOnly) {
    const bad = [];
    for (const e of ENTRIES) {
      const p = outPathOf(e);
      const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
      if (have !== buildEntry(src, e.instance)) bad.push(e.dir + '/index.html');
    }
    if (!bad.length) { console.log('[OK] live/index.html 与 index.html 同步'); process.exit(0); }
    console.error('[FAIL] 与 index.html 不同步: ' + bad.join(', ') + ' —— 请跑 node build_live.cjs');
    process.exit(1);
  }

  for (const e of ENTRIES) {
    const want = buildEntry(src, e.instance);
    const p = outPathOf(e);
    const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    if (have === want) { console.log(e.dir + '/index.html 已是最新，无需改动'); continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, want);
    console.log(e.dir + '/index.html 已生成（' + want.length + ' 字节）');
  }
}

module.exports = { buildLive, buildEntry, SRC, ENTRIES };

if (require.main === module) main();
