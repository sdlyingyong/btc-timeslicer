#!/bin/bash
# 每日自动更新 btc-timeslicer 数据：拉取最新 15m K 线 -> 重写 index.html -> 提交并推送 GitHub Pages
# 由 launchd (com.btctimeslicer.update.plist) 在凌晨 4 点触发。
set -u

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR" || exit 1

# launchd 环境 PATH 很精简，这里补上 node / git 所在目录
export PATH="/Users/mac/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# ---- 网络代理（国内访问交易所 / GitHub 所需）----
# 默认用本机常见代理端口；如不同请修改，或在外面 export HTTPS_PROXY 覆盖
PROXY_URL="${HTTPS_PROXY:-http://127.0.0.1:10809}"
export HTTPS_PROXY="$PROXY_URL"
export HTTP_PROXY="$PROXY_URL"
export NODE_USE_ENV_PROXY=1
# git 走代理（仅本次调用生效，不改全局配置）
GIT_PX=(-c "http.proxy=$PROXY_URL" -c "https.proxy=$PROXY_URL")

# 数据源：okx(默认, 国内可直连) | binance(需区域合规反代, 可加 BINANCE_BASE)
export SOURCE="${SOURCE:-okx}"

LOG="$REPO_DIR/update.log"
exec >>"$LOG" 2>&1

echo "===== $(date '+%F %T') 开始每日更新 (source=$SOURCE) ====="

# 用 caffeinate 保活，避免机器在跑任务时休眠
caffeinate -i /Users/mac/.local/node/bin/node update_data.cjs
RC=$?
if [ "$RC" -ne 0 ]; then
  echo "$(date '+%F %T') node 更新失败 (rc=$RC)，中止提交"
  exit $RC
fi

if git diff --quiet index.html; then
  echo "$(date '+%F %T') index.html 无变化，跳过提交"
  echo "===== 结束 ====="
  exit 0
fi

# 先快进同步远端，避免本地落后导致 push 被拒（冲突则本次放弃）
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if ! git "${GIT_PX[@]}" pull --ff-only "origin" "$BRANCH"; then
  echo "$(date '+%F %T') git pull 失败（可能远端有冲突改动），跳过本次提交/推送"
  exit 1
fi

git add index.html
git commit -m "data: daily update $(date '+%F') (source=$SOURCE)"
if git "${GIT_PX[@]}" push "origin" "$BRANCH"; then
  echo "$(date '+%F %T') 已提交并推送到 GitHub Pages"
else
  echo "$(date '+%F %T') git push 失败，请检查代理/凭据（本地 index.html 已更新）"
fi
echo "===== 结束 ====="
