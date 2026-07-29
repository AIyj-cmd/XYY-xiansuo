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
npm install -g pm2 tsx

echo "====== [4/7] 创建目录 ======"
mkdir -p $APP_DIR $LOG_DIR
mkdir -p $APP_DIR/server/data
mkdir -p $APP_DIR/server/uploads

echo "====== [5/7] 配置 Nginx ======"
cp /tmp/xiansuo-nginx.conf /etc/nginx/sites-available/xiansuo
ln -sf /etc/nginx/sites-available/xiansuo /etc/nginx/sites-enabled/xiansuo
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "====== [6/7] 申请 SSL 证书 ======"
# 先用 HTTP-only 临时配置获取证书
cat > /etc/nginx/sites-available/xiansuo-temp << 'EOF'
server {
    listen 80;
    server_name xs.tomatopia.top;
    location / { return 200 'ok'; }
}
EOF
ln -sf /etc/nginx/sites-available/xiansuo-temp /etc/nginx/sites-enabled/xiansuo
nginx -t && systemctl reload nginx
certbot certonly --nginx -d xs.tomatopia.top --non-interactive --agree-tos -m admin@tomatopia.top
# 切回正式配置
ln -sf /etc/nginx/sites-available/xiansuo /etc/nginx/sites-enabled/xiansuo
nginx -t && systemctl reload nginx

echo "====== [7/7] 启动定时续签 ======"
(crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet && systemctl reload nginx") | crontab -

echo "====== 完成！接下来运行 deploy.sh 上传代码 ======"
