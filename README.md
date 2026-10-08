# BTC 时光机 · K线复盘工具

一个 BTC K 线复盘 / 看盘网页（USDT 本位永续，1d / 4h / 1h / 15m，15m 全量 24.8 万根），部署在 GitHub Pages。

## 两个入口（各自独立保存进度）

| 入口 | 地址 | 用途 |
| --- | --- | --- |
| **复盘** | https://sdlyingyong.github.io/btc-timeslicer/ | 回看历史、画线复盘；记住你上次看到哪 |
| **看盘** | https://sdlyingyong.github.io/btc-timeslicer/live/ | 看当前盘面；同样记自己的位置 |

两个入口都在 `sdlyingyong.github.io` 下 —— 而 **origin 只看「协议 + 域名」，不看路径**，
所以它们共享同一份 localStorage / IndexedDB。为了「各存各的进度互不覆盖」，页面里做了
**实例命名空间**：入口页注入 `window.__APP_INSTANCE__`（`review` / `live`），
除复盘外所有存储键都加 `live__` 前缀（复盘保持原键名，**已有进度不会丢**）。
覆盖的键共 8 个：`kline_session_v1`（画线+视图）、`kline_view_prefs_v1`、`kline_trades_v1`、
`kline_sim_v1`、`kline_toolbar_order_v1`、`focus_timer`、`focus_history`、IndexedDB 库 `kline_cache_v1`。

## 功能

- **多周期**：日线 / 4小时 / 1小时 / 15分钟 一键切换，时间范围 2019-09-08 起（BTC-USDT 永续）
- **复盘工具**：画线（趋势线 / 水平线 / 测量线 / 价格通道）、EMA20/EMA120、对数/线性坐标切换、VOL 成交量
- **盈亏比计算**：点击「盈亏比」后按住 K 线定入场，拖出止盈 TP、拖出止损 SL，三条线可拖动实时计算 R（盈亏比）、回报%/风险%，多空切换自动换位
- **专注计时器**：番茄工作法风格记录复盘时长，关闭窗口自动暂停、重开续接，可完成归档并查看历史（次数/时长/今日汇总）
- **浏览记忆**：每个周期的画线、缩放位置自动保存（localStorage），关掉再打开原样恢复；「重置刷新」一键清空
- **OKX 风格时间轴**：自然间隔主/次刻度，跨天首标签带日期，跨年标签带年份
- **性能**：大缩放（单帧 24.4 万根 K 线）采用像素桶聚合降采样，canvas 绘制调用从 193 万次/帧降至约 4 千次/帧（-99.8%），绘制耗时 836ms → 23ms（-97%）

## 目录结构

```
index.html            # 复盘入口（壳：CSS + 面板 DOM + 3 行 <script>）
live/index.html       # 看盘入口（由 build_live.cjs 从 index.html 生成，勿手改）
share/app.js          # 全部逻辑（唯一一份，两个入口共用）
share/data.js         # 全部行情数据（唯一一份，~17MB，每日更新）
build_live.cjs        # 生成 live/index.html（node build_live.cjs [--check]）
build_offline.cjs     # 生成「真·单文件离线版」：node build_offline.cjs
tests/regression.test.cjs   # 主回归（轻量 mock，369 断言）
tests/smoke_entries.cjs     # 双入口端到端冒烟（真 DOM，需 jsdom）
```

数据只有 `share/data.js` 一份 —— 两个入口引用同一个文件，所以每天更新只需一次 17MB 提交。

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
2. 访问 `https://<用户名>.github.io/<仓库名>/`（复盘）与 `.../live/`（看盘）
3. 改了入口壳（`index.html`）记得跑一次 `node build_live.cjs`，否则看盘入口不会跟着变
   （回归测试里有漂移检查，不同步会 FAIL）

## 技术细节

- **单一数据源**：数据以分钟级 epoch 数值存放（`[t, o, h, l, c, v]` 六字段），体积约 17MB，
  放在 `share/data.js` 由两个入口共用；需要单文件时用 `build_offline.cjs` 内联出来
- **渲染优化**：
  - `xW >= 1`（K 线 ≥1px）：逐根绘制
  - `xW < 1`（大缩放）：每像素一桶，蜡烛取桶内 maxHi/minLo + 首开末收，EMA 取桶中点采样，VOL 桶内求和后按桶级最大值归一化
- 隐私：不含任何个人账户、交割单或交易记录，纯本地计算

## 数据来源

BTC-USDT 永续合约（`BTC-USDT-SWAP`）15 分钟 K 线，取自 OKX；1h / 4h 直接取 OKX，1d 由 4h 重采样到 UTC 00:00
（OKX 原生 1D 锚定 16:00 UTC，与历史网格错位，不能用）。量能存 `volCcy`（币），不是 `vol`（张）—— 两者差 100 倍。

```
HTTPS_PROXY=http://127.0.0.1:10809 node update_data.cjs   # 写 share/data.js
node validate_data.cjs                                    # 校验（缺口/乱序/量能口径）
```

本页仅用于行情回看与复盘，不构成任何投资建议。
