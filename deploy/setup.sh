#!/bin/bash
# 在阿里云服务器上以 root 身份执行
set -e

APP_DIR=/opt/xiansuo
LOG_DIR=/var/log/xiansuo
NODE_VERSION=22

echo "====== [1/7] 安装 Node.js $NODE_VERSION ======"
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
apt-get install -y nodejs

echo "====== [2/7] 安装 Nginx 和 Certbot ======"
apt-get install -y nginx certbot python3-certbot-nginx

echo "====== [3/7] 安装 PM2 ======"
npm install -g pm2

echo "====== [4/7] 创建目录 ======"
mkdir -p $APP_DIR $LOG_DIR
mkdir -p $APP_DIR/server/data
mkdir -p $APP_DIR/server/uploads

echo "====== [5/7] 配置 Nginx ======"
# 首次申请证书前不能加载引用尚不存在证书文件的正式 HTTPS 配置。
# 先启用纯 HTTP 配置供 Certbot 完成域名校验。
cat > /etc/nginx/sites-available/xiansuo << 'EOF'
server {
    listen 80;
    server_name xs.tomatopia.top;
    location / { return 200 'certificate bootstrap'; }
}
EOF
ln -sf /etc/nginx/sites-available/xiansuo /etc/nginx/sites-enabled/xiansuo
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "====== [6/7] 申请 SSL 证书 ======"
certbot certonly --nginx -d xs.tomatopia.top --non-interactive --agree-tos -m admin@tomatopia.top
# 证书存在后再切换到正式 HTTPS 反向代理配置。
cp /tmp/xiansuo-nginx.conf /etc/nginx/sites-available/xiansuo
nginx -t && systemctl reload nginx

echo "====== [7/7] 启动定时续签 ======"
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | crontab -

echo "====== 完成！接下来运行 deploy.sh 上传代码 ======"
