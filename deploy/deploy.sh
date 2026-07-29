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
tar -czf $PACK \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='app/node_modules' \
  --exclude='server/node_modules' \
  --exclude='server/data' \
  --exclude='server/uploads' \
  server/ \
  app/dist/build/h5/ \
  deploy/

echo "====== [3/4] 上传到服务器 ======"
scp $PACK $SERVER:/tmp/
scp deploy/nginx.conf $SERVER:/tmp/xiansuo-nginx.conf

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
cd $APP_DIR/server && npm install --production

# 用 PM2 启动/重载
if pm2 list | grep -q xiansuo; then
  pm2 reload ecosystem.config.cjs --update-env
else
  cp /tmp/xiansuo-src/deploy/ecosystem.config.cjs $APP_DIR/
  chmod 600 $APP_DIR/ecosystem.config.cjs  # 里面有 JWT_SECRET 明文，禁止同机其他用户读取
  cd $APP_DIR && pm2 start ecosystem.config.cjs
fi
chmod 600 $APP_DIR/ecosystem.config.cjs
pm2 save

echo "部署完成！"
REMOTE

echo ""
echo "====== 部署成功 ======"
echo "访问：https://xs.tomatopia.top"
