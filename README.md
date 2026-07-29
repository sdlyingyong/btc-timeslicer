# BTC 时光机 · 单文件网页版

一个**只含 BTC** 的离线 K 线回看工具，所有数据（日线 / 4h / 1h / 15 分，15m 全量 24.1 万根）全部内联在这个 `index.html` 里。

- 数据范围：2019-09-08 ~ 2026-07-28（BTC-USDT 永续）
- 功能：对数坐标、EMA20/120、键盘 ←/→ 逐根步进、滚轮缩放、VOL、画线、锁定时间
- 体积：约 30.5 MB（数据全内联的代价，浏览器可正常打开）
- 隐私：不含任何个人账户、交割单或交易记录

---

## 部署成「别人点链接就能看」的公开网页

### 方案 A：Netlify Drop（最省事，无需装 git / 不用命令行）
1. 打开 https://app.netlify.com/drop
2. 把本文件夹（`btc-single-web`）整个拖进去
3. 几秒后拿到 `https://xxx.netlify.app` 公开网址，发给任何人即可直接看图

> 首次可能要求用邮箱注册/登录 Netlify（免费），拖完即生效。

### 方案 B：GitHub Pages（你已有 GitHub 账号时）
1. 新建一个公开仓库，把本文件夹内容（至少 `index.html`）推上去
2. 仓库 `Settings → Pages`，Source 选 `main` 分支根目录，保存
3. 稍等片刻，访问 `https://<你的用户名>.github.io/<仓库名>/` 即为公开页

若本机装了 git，可在本文件夹内执行：
```
git init && git add . && git commit -m "btc single web"
git branch -M main
git remote add origin https://github.com/<用户名>/<仓库名>.git
git push -u origin main
```

### 其它可选
- Vercel：https://vercel.com → Add New → 拖入本文件夹
- Cloudflare Pages：https://pages.cloudflare.com → 直接拖放部署

---

## 本地自测
双击 `index.html` 即可离线打开（file:// 也行），或用：
```
python -m http.server 8080 --directory btc-single-web
# 浏览器访问 http://localhost:8080
```
