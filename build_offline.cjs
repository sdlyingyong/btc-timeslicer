#!/usr/bin/env node
// 把「入口壳 + share/app.js + share/data.js」内联成**一个** HTML 文件（真·单文件离线版）。
// 用途：离线备份、发给别人、放 U 盘 —— 拷一个文件就能用，双击 file:// 打开也行。
// 注意：产物不进仓库（见 .gitignore），要留就自己拷走。
//
// 用法：node build_offline.cjs [输出路径]     默认 ./btc-timeslicer-offline.html
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = __dirname;
const out = process.argv[2] || path.join(REPO, 'btc-timeslicer-offline.html');

const shell = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(REPO, 'share', 'app.js'), 'utf8');
const data = fs.readFileSync(path.join(REPO, 'share', 'data.js'), 'utf8');

// 外链 → 内联（只替这两条，实例标记保持 review）
const re = /<script src="share\/data\.js"><\/script>\s*<script src="share\/app\.js"><\/script>/;
if (!re.test(shell)) { console.error('[FAIL] 未在 index.html 找到外链 script 标签（结构变了？）'); process.exit(1); }
const single = shell.replace(re,
  '<script>\n' + data + '\n</script>\n<script>\n' + app + '\n</script>');

fs.writeFileSync(out, single);
console.log('已生成单文件离线版: ' + out + '（' + single.length + ' 字节）');
