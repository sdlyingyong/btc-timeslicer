#!/bin/bash
# 每日自动更新 btc-timeslicer 数据：拉取币安最新 15m K 线 -> 重写 index.html -> 提交并推送 GitHub Pages
# 由 launchd (com.btctimeslicer.update.plist) 在凌晨 4 点触发。
set -u

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_DIR" || exit 1

# launchd 环境 PATH 很精简，这里补上 node / git 所在目录
export PATH="/Users/mac/.local/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# 国内访问币安被墙时，设成你自己的反代基址（只需转发 /fapi/v1/klines，无需鉴权）
# export BINANCE_BASE="https://你的反代域名/fapi"

LOG="$REPO_DIR/update.log"
exec >>"$LOG" 2>&1

echo "===== $(date '+%F %T') 开始每日更新 ====="

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
if ! git pull --ff-only "origin" "$BRANCH"; then
  echo "$(date '+%F %T') git pull 失败（可能远端有冲突改动），跳过本次提交/推送"
  exit 1
fi

git add index.html
git commit -m "data: daily update $(date '+%F')"
if git push; then
  echo "$(date '+%F %T') 已提交并推送到 GitHub Pages"
else
  echo "$(date '+%F %T') git push 失败，请检查凭据/网络"
fi
echo "===== 结束 ====="
