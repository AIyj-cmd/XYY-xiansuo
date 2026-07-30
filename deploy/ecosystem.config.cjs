module.exports = {
  apps: [
    {
      name: 'xiansuo',
      cwd: '/opt/xiansuo/server',
      script: 'dist/index.js',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOST: '127.0.0.1',
        DB_PATH: process.env.DB_PATH,
        JWT_SECRET: process.env.JWT_SECRET,
        ADMIN_INITIAL_USERNAME: process.env.ADMIN_INITIAL_USERNAME || 'admin',
        ADMIN_INITIAL_NAME: process.env.ADMIN_INITIAL_NAME || '管理员',
        ADMIN_INITIAL_PASSWORD: process.env.ADMIN_INITIAL_PASSWORD,
        POOL_IDLE_DAYS: process.env.POOL_IDLE_DAYS || '7',
        CORS_ORIGINS: process.env.CORS_ORIGINS,
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/var/log/xiansuo/error.log',
      out_file: '/var/log/xiansuo/out.log',
      max_memory_restart: '512M',
      restart_delay: 3000,
      autorestart: true,
    },
  ],
};
