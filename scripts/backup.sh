#!/bin/bash
# 每日数据库备份脚本
# 使用方法：bash scripts/backup.sh
# crontab 示例（每天 02:00 执行）：
# 0 2 * * * cd /path/to/project && bash scripts/backup.sh >> /var/log/xiansuo-backup.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="$SCRIPT_DIR/../server/data/app.db"
BACKUP_DIR="$SCRIPT_DIR/../server/backups"
DATE=$(date +%Y%m%d)
BACKUP_FILE="$BACKUP_DIR/app-$DATE.db"
KEEP_DAYS=7

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "[$(date)] 数据库文件不存在: $DB_PATH"
  exit 1
fi

# WAL checkpoint（确保备份完整）
sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" 2>/dev/null || echo "[$(date)] WAL checkpoint 失败，继续备份"

cp "$DB_PATH" "$BACKUP_FILE"
echo "[$(date)] 备份完成: $BACKUP_FILE"

# 保留最近 7 份
ls -t "$BACKUP_DIR"/app-*.db 2>/dev/null | tail -n +$((KEEP_DAYS + 1)) | xargs rm -f 2>/dev/null
echo "[$(date)] 已清理旧备份，保留最近 $KEEP_DAYS 份"
