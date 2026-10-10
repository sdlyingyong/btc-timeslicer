# BTC 时光机 · K线复盘工具

一个 BTC / ETH K 线复盘·看盘网页（USDT 本位永续，1d / 4h / 1h / 15m；15m 全量 BTC 24.8 万根、ETH 24.1 万根），部署在 GitHub Pages。

## 三个入口（各自独立保存进度）

| 入口 | 地址 | 用途 |
| --- | --- | --- |
| **复盘** | https://sdlyingyong.github.io/btc-timeslicer/ | 回看历史、画线复盘；记住你上次看到哪 |
| **看盘** | https://sdlyingyong.github.io/btc-timeslicer/live/ | 看当前盘面；每 5 分钟直连 OKX 自动补数 |
| **自选** | https://sdlyingyong.github.io/btc-timeslicer/watch/ | 自选多币种（BTC / ETH）+ WebSocket 实时；ETH 带 **2019 起全量历史**（按年分片渐进加载，§32 / §33） |

三个入口都在 `sdlyingyong.github.io` 下 —— 而 **origin 只看「协议 + 域名」，不看路径**，
所以它们共享同一份 localStorage / IndexedDB。为了「各存各的进度互不覆盖」，页面里做了
**实例命名空间**：入口页注入 `window.__APP_INSTANCE__`（`review` / `live` / `watch`），
除复盘外所有存储键都加实例前缀（`live__` / `watch__`；复盘保持原键名，**已有进度不会丢**）。
覆盖的键共 9 个：`kline_session_v1`（画线+视图）、`kline_view_prefs_v1`、`kline_trades_v1`、
`kline_sim_v1`、`kline_toolbar_order_v1`、`kline_watchlist_v1`（自选列表）、`focus_timer`、
`focus_history`、IndexedDB 库 `kline_cache_v1`。

## 功能

- **多周期**：日线 / 4小时 / 1小时 / 15分钟 一键切换，时间范围 2019-09-08 起（BTC-USDT 永续）
- **复盘工具**：画线（趋势线 / 水平线 / 测量线 / 价格通道）、EMA20/EMA120、对数/线性坐标切换、VOL 成交量
- **盈亏比计算**：点击「盈亏比」后按住 K 线定入场，拖出止盈 TP、拖出止损 SL，三条线可拖动实时计算 R（盈亏比）、回报%/风险%，多空切换自动换位
- **专注计时器**：番茄工作法风格记录复盘时长，关闭窗口自动暂停、重开续接，可完成归档并查看历史（次数/时长/今日汇总）
- **浏览记忆**：每个周期的画线、缩放位置自动保存（localStorage），关掉再打开原样恢复；「重置刷新」一键清空
- **OKX 风格时间轴**：自然间隔主/次刻度，跨天首标签带日期，跨年标签带年份
- **性能**：大缩放（单帧 24.4 万根 K 线）采用像素桶聚合降采样，canvas 绘制调用从 193 万次/帧降至约 4 千次/帧（-99.8%），绘制耗时 836ms → 23ms（-97%）
- **自选看盘（§32 MVP）**：左侧自选列表（代码 / 最新价 / 24h 涨跌幅 / 迷你走势）+ 右侧保留全部时光机能力；
  一条 WebSocket 订阅 N 个币 × 3 个周期（秒级推送，请求数不随币种增长）；**连不上就显式写「离线」并降级为
  REST 轮询兜底，绝不假装有数据**
- **ETH 全量历史（§33）**：自选里的 ETH 不再是「只有 300 根」—— 按 UTC 自然年切成 8 个分片
  （`share/eth/YYYY.js`，合计 **15.5 MB** / 2019-11-27 起 **24.1 万根** 15m），**新→旧渐进加载**
  （首屏只等最近 2 年 ≈4.1 MB），每片落地即上图，历史一年一年往前长；
  **某年加载失败会在状态位显式报出来**（`历史 n/8 · N 年加载失败`），绝不假装有数据

## 目录结构

```
index.html            # 复盘入口（壳：CSS + 面板 DOM + 3 行 <script>）
live/index.html       # 看盘入口（由 build_live.cjs 从 index.html 生成，勿手改）
watch/index.html      # 自选入口（同上，由 build_live.cjs 生成，勿手改）
share/app.js          # 全部逻辑（唯一一份，三个入口共用）
share/data.js         # BTC 行情数据（唯一一份，~17MB，每日更新）
share/eth/YYYY.js     # §33 ETH 年分片（8 片，2019–2026，合计 15.5MB）—— 只有 watch 入口引用
share/eth/manifest.js # §33 ETH 分片清单（年份 / 根数 / 源仓库 / 构建日期）
build_live.cjs        # 生成 live/ 与 watch/ 两个入口壳（node build_live.cjs [--check]）
build_offline.cjs     # 生成「真·单文件离线版」：node build_offline.cjs
build_eth_shards.cjs  # §33 从 kline-timemachine 构建 ETH 历史分片（一次性 / 幂等）
update_eth_data.cjs   # §33 ETH 分片尾部增量（OKX 15m，接在分片末端之后，可每日重跑）
tests/regression.test.cjs   # 主回归（轻量 mock，486 断言）
tests/smoke_entries.cjs     # 三入口端到端冒烟（真 DOM，需 jsdom）
```

数据分两块：`share/data.js`（BTC，三个入口共用的唯一一份）；`share/eth/*.js`（ETH 全量历史分片，
**只有 watch 入口引用**，复盘 / 看盘 `grep share/eth` 是零命中）。
两者都是独立静态文件（`<script src>`），所以体积不压在首屏 DOM 上，也不会互相牵连。

## 使用方法

### 本地使用
直接双击根目录的 `index.html`（它会去读同目录的 `share/`，file:// 下可用）。
想要**单个 HTML 文件**拷来拷去：

```
node build_offline.cjs        # 产出 btc-timeslicer-offline.html（约 17MB，自带全部数据）
```

也可以起个本地服务：`python -m http.server 8080`

### 部署到 GitHub Pages
1. 仓库 `Settings → Pages`，Source 选 `main` 分支根目录，保存
2. 访问 `https://<用户名>.github.io/<仓库名>/`（复盘）、`.../live/`（看盘）、`.../watch/`（自选）
3. 改了入口壳（`index.html`）记得跑一次 `node build_live.cjs`，否则派生入口不会跟着变
   （回归测试里有漂移检查，不同步会 FAIL）

## 技术细节

- **单一数据源**：数据以分钟级 epoch 数值存放（`[t, o, h, l, c, v]` 六字段），体积约 17MB，
  放在 `share/data.js` 由两个入口共用；需要单文件时用 `build_offline.cjs` 内联出来
- **渲染优化**：
  - `xW >= 1`（K 线 ≥1px）：逐根绘制
  - `xW < 1`（大缩放）：每像素一桶，蜡烛取桶内 maxHi/minLo + 首开末收，EMA 取桶中点采样，VOL 桶内求和后按桶级最大值归一化
- 隐私：不含任何个人账户、交割单或交易记录，纯本地计算

## 数据来源

**BTC**：USDT 永续（`BTC-USDT-SWAP`）15 分钟 K 线。历史段来自外部数据仓库，尾部每日取 OKX；
1h / 4h 由 15m 重采样，1d 锚定 UTC 00:00（OKX 原生 1D 锚定 16:00 UTC，与历史网格错位，不能用）。

**ETH（§33）**：历史段取自用户已有的 GitHub 仓库
[`sdlyingyong/kline-timemachine`](https://github.com/sdlyingyong/kline-timemachine)
（`fut_data/eth_15m_0000..0011.json`，2019-11-27 起 233,730 根），在其上按 UTC 自然年切分片；
之后每天用 OKX 把分片末端向前推进（`update_eth_data.cjs`），保证「分片末端」与「当前」之间的空隙
始终不超过 REST 能覆盖的 3.1 天。两个源实测价格差 ≤0.05%、量比 1.0–1.5×（同一被套利锁死的市场）。

⚠️ **量能一律存 `volCcy`（币本位）**，不是 `vol`（张）也不是 USDT 成交额 ——
BTC-USDT-SWAP 的 ctVal=0.01、ETH-USDT-SWAP 是 0.1，口径混用会造成「半屏柱子看不见、半屏顶满」。
`validate_data.cjs` 用滚动台阶（阈值 20×）把这条线焊死。

```bash
HTTPS_PROXY=http://127.0.0.1:10809 node update_data.cjs       # 写 share/data.js（BTC，每日）
HTTPS_PROXY=http://127.0.0.1:10809 node update_eth_data.cjs   # 推进 share/eth/（ETH，每日）
node validate_data.cjs                                        # 校验 BTC + ETH（缺口 / 乱序 / 量能口径 / 分片自洽）
node build_eth_shards.cjs                                     # 只在需要重建 ETH 全量历史时跑（幂等）
```

本页仅用于行情回看与复盘，不构成任何投资建议。
