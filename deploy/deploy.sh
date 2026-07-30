#!/bin/bash
# 在本机执行，将代码打包上传到服务器
# 用法：bash deploy/deploy.sh root@47.82.105.103
set -e

SERVER=${1:-root@47.82.105.103}
APP_DIR=/opt/xiansuo
PACK=/tmp/xiansuo-pack.tar.gz

echo "====== [1/4] 构建前端 H5 ======"
cd "$(dirname "$0")/.."
(cd app && npm run build:h5)

echo "====== [2/4] 打包文件 ======"
tar -czf "$PACK" \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='app/node_modules' \
  --exclude='server/node_modules' \
  --exclude='server/dist' \
  --exclude='server/data' \
  --exclude='server/uploads' \
  server/ \
  app/dist/build/h5/ \
  deploy/

echo "====== [3/4] 上传到服务器 ======"
scp "$PACK" "$SERVER:/tmp/"
scp deploy/nginx.conf "$SERVER:/tmp/xiansuo-nginx.conf"

echo "====== [4/4] 在服务器上部署 ======"
ssh $SERVER << 'REMOTE'
set -e
cd /tmp
rm -rf /tmp/xiansuo-src
mkdir /tmp/xiansuo-src
tar -xzf xiansuo-pack.tar.gz -C /tmp/xiansuo-src

APP_DIR=/opt/xiansuo

# 同步 server 代码
rsync -a --exclude='data' --exclude='uploads' /tmp/xiansuo-src/server/ $APP_DIR/server/

# 同步前端产物
mkdir -p $APP_DIR/app/dist/build/h5
rsync -a /tmp/xiansuo-src/app/dist/build/h5/ $APP_DIR/app/dist/build/h5/

# 安装 server 依赖
cd "$APP_DIR/server"
npm ci
npm run build
npm prune --omit=dev

# 运行密钥只保存在服务器，不进入 Git 仓库或部署包。
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp /tmp/xiansuo-src/deploy/.env.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "首次部署需要先编辑 $ENV_FILE，设置至少 32 字节的 JWT_SECRET，然后重新执行部署。"
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if [ "${#JWT_SECRET}" -lt 32 ]; then
  echo "$ENV_FILE 中的 JWT_SECRET 未设置或不足 32 字节，拒绝重启服务。"
  exit 1
fi

if [ -z "${DB_PATH:-}" ] || [ "${DB_PATH#/}" = "$DB_PATH" ]; then
  echo "$ENV_FILE 必须配置绝对 DB_PATH，避免部署到错误的本地默认数据库。"
  exit 1
fi

# 每次同步 PM2 配置，避免后续部署仍使用旧配置或错误工作目录。
cp /tmp/xiansuo-src/deploy/ecosystem.config.cjs "$APP_DIR/ecosystem.config.cjs"
chmod 600 "$APP_DIR/ecosystem.config.cjs" "$ENV_FILE"
cd "$APP_DIR"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "部署完成！"
REMOTE

echo ""
echo "====== 部署成功 ======"
echo "访问：https://xs.tomatopia.top"
