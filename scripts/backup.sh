#!/bin/bash
# 每日数据库备份脚本
# 使用方法：bash scripts/backup.sh
# crontab 示例（每天 02:00 执行）：
# 0 2 * * * cd /path/to/project && bash scripts/backup.sh >> /var/log/xiansuo-backup.log 2>&1
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 与服务一致：未设置时备份默认库；生产环境应传入绝对 DB_PATH。
DB_FILE="${DB_PATH:-$SCRIPT_DIR/../server/data/app.db}"
BACKUP_DIR="$SCRIPT_DIR/../server/backups"
DATE=$(date +%Y%m%d)
BACKUP_FILE="$BACKUP_DIR/app-$DATE.db"
TMP_BACKUP="$BACKUP_FILE.tmp"
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [ ! -f "$DB_FILE" ]; then
  echo "[$(date)] 数据库文件不存在: $DB_FILE"
  exit 1
fi

# SQLite 在线备份能在服务仍有读写时生成一致快照，比直接复制 WAL 数据库可靠。
sqlite3 "$DB_FILE" ".backup '$TMP_BACKUP'"
chmod 600 "$TMP_BACKUP"
mv "$TMP_BACKUP" "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
echo "[$(date)] 备份完成: $BACKUP_FILE"

# 保留最近 7 份
ls -t "$BACKUP_DIR"/app-*.db 2>/dev/null | tail -n +$((KEEP_DAYS + 1)) | xargs rm -f 2>/dev/null
echo "[$(date)] 已清理旧备份，保留最近 $KEEP_DAYS 份"
