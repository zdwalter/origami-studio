#!/usr/bin/env bash
# ============================================================
# 纸境 · 折纸仿真平台 — 部署到 game.sopher.cool
#   ./deploy/deploy.sh
#
# 目标：
#   root@game.sopher.cool:/var/www/game.sopher.cool/origami
#
# 可选：
#   DEPLOY_HOST / DEPLOY_ROOT / DEPLOY_SUBDIR
#   DRY_RUN=1        只演练，不写远端
#   SKIP_PORTAL=1    只传游戏，不改门户首页
#   DEPLOY_SSH_OPTS  额外 ssh 参数
# ============================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
SUBDIR="${DEPLOY_SUBDIR:-origami}"
DEPLOY_HOST="${DEPLOY_HOST:-root@game.sopher.cool}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/var/www/game.sopher.cool}"
COVER="origami-cover.jpg"
DRY="${DRY_RUN:-0}"
SKIP_PORTAL="${SKIP_PORTAL:-0}"
STAMP="$(date +%Y%m%d-%H%M%S)"
SSH_CMD="ssh ${DEPLOY_SSH_OPTS:-}"
RSYNC_EXTRA=""
[ "$DRY" = "1" ] && RSYNC_EXTRA="--dry-run -v"

say() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------- 0. 本地校验 ----------
NODE_BIN=""
if [ -x "/Users/dw.zheng/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" ]; then
  NODE_BIN="/Users/dw.zheng/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi
if [ -n "$NODE_BIN" ]; then
  say "校验 JS 语法"
  for f in "$SRC"/js/*.js; do "$NODE_BIN" --check "$f" || fail "语法错误: $f"; done
fi
[ -f "$HERE/$COVER" ] || fail "缺少封面 $HERE/$COVER（先跑 make_cover.py）"

say "源目录   : $SRC"
say "目标     : $DEPLOY_HOST:$DEPLOY_ROOT/$SUBDIR"
say "版本     : $STAMP"
[ "$DRY" = "1" ] && say "DRY RUN  : 不上传、不写远端"

# ---------- 1. 上传游戏本体 ----------
# 只传运行所需文件；tests/ tools/ deploy/ README.md 等开发物料不上去。
say "上传游戏文件（--delete 保证与本地一致）"
rsync -rltz --delete $RSYNC_EXTRA -e "$SSH_CMD" --no-p --no-o --no-g \
  --exclude '.DS_Store' \
  --exclude '.git' \
  --exclude 'deploy/' \
  --exclude 'tests/' \
  --exclude 'tools/' \
  --exclude 'README.md' \
  --exclude 'SPEC.md' \
  --exclude 'cpeditor-demo.html' \
  --exclude 'stepfold-demo.html' \
  "$SRC/" "$DEPLOY_HOST:$DEPLOY_ROOT/$SUBDIR/"

# ---------- 2. js/css 打版本号 ----------
# 页面是 no-cache，但 .js/.css 会按启发式规则被浏览器长期缓存，
# 每次部署给引用加 ?v=<时间戳>，保证访客拿到新脚本。
if [ "$DRY" != "1" ]; then
  say "给 js/css 引用打版本号 $STAMP"
  rsync -rltz -e "$SSH_CMD" --no-p --no-o --no-g "$HERE/stamp_assets.py" "$DEPLOY_HOST:/tmp/stamp_assets.py"
  $SSH_CMD "$DEPLOY_HOST" "cd '$DEPLOY_ROOT/$SUBDIR' && python3 /tmp/stamp_assets.py '$STAMP' index.html && \
    printf '{\"version\":\"%s\"}' '$STAMP' > version.json && \
    chown www-data:www-data index.html version.json && chmod 644 index.html version.json"
fi

# ---------- 3. 上传封面 ----------
say "上传封面 assets/$COVER"
rsync -rltz $RSYNC_EXTRA -e "$SSH_CMD" --no-p --no-o --no-g "$HERE/$COVER" "$DEPLOY_HOST:$DEPLOY_ROOT/assets/$COVER"

# ---------- 4. 更新门户首页 ----------
if [ "$SKIP_PORTAL" != "1" ]; then
  say "更新门户首页（本地打补丁 → 远端备份 → 覆盖上传）"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  rsync -az -e "$SSH_CMD" "$DEPLOY_HOST:$DEPLOY_ROOT/index.html" "$TMP/index.html"
  python3 "$HERE/patch_portal.py" "$TMP/index.html" "$HERE/portal-card.html" "$TMP/index.new.html"
  SUM_LOCAL=$(openssl dgst -md5 -r "$TMP/index.new.html" | awk '{print $1}')
  SUM_REMOTE=$($SSH_CMD "$DEPLOY_HOST" "openssl dgst -md5 -r '$DEPLOY_ROOT/index.html' | awk '{print \$1}'" 2>/dev/null || echo none)
  if [ "$DRY" = "1" ]; then
    say "DRY RUN：跳过远端备份与覆盖"
  elif [ "$SUM_LOCAL" = "$SUM_REMOTE" ]; then
    say "门户首页内容无变化，跳过备份与上传"
  else
    $SSH_CMD "$DEPLOY_HOST" "cp '$DEPLOY_ROOT/index.html' '$DEPLOY_ROOT/index.html.bak-$STAMP'"
    say "远端已备份为 index.html.bak-$STAMP"
    rsync -rltz -e "$SSH_CMD" --no-p --no-o --no-g "$TMP/index.new.html" "$DEPLOY_HOST:$DEPLOY_ROOT/index.html"
    $SSH_CMD "$DEPLOY_HOST" "chown www-data:www-data '$DEPLOY_ROOT/index.html' && chmod 644 '$DEPLOY_ROOT/index.html'"
  fi
fi

# ---------- 5. 权限兜底 ----------
if [ "$DRY" != "1" ]; then
  say "修正远端权限（nginx 需要可读）"
  $SSH_CMD "$DEPLOY_HOST" "chown -R www-data:www-data '$DEPLOY_ROOT/$SUBDIR' '$DEPLOY_ROOT/assets/$COVER' && \
    find '$DEPLOY_ROOT/$SUBDIR' -type d -exec chmod 755 {} + && \
    find '$DEPLOY_ROOT/$SUBDIR' -type f -exec chmod 644 {} + && chmod 644 '$DEPLOY_ROOT/assets/$COVER'"
fi

# ---------- 6. 自检 ----------
if [ "$DRY" != "1" ]; then
  say "自检"
  BASE="https://game.sopher.cool"
  check() {
    code=$(curl -s -o /dev/null -m 30 -w '%{http_code}' "$1" || echo 000)
    printf '  %-70s %s\n' "$1" "$code"
    [ "$code" = "200" ] || fail "自检失败: $1"
  }
  check "$BASE/$SUBDIR/index.html"
  check "$BASE/$SUBDIR/css/app.css"
  for f in "$SRC"/js/*.js; do check "$BASE/$SUBDIR/js/$(basename "$f")"; done
  check "$BASE/assets/$COVER"
  check "$BASE/$SUBDIR/dist/origami-studio.html"

  printf '  %-70s ' "门户首页卡片 + 在架数量"
  PORTAL=$(curl -s -m 30 "$BASE/")
  if printf '%s' "$PORTAL" | grep -q '纸境' && printf '%s' "$PORTAL" | grep -q 'id="gameCount">14<'; then
    echo 'OK'
  else
    echo '未确认，请检查'
    fail "门户卡片或在架数量未验证通过"
  fi
  say "部署完成：$BASE/$SUBDIR/index.html"
fi
