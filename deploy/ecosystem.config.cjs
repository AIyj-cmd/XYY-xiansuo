module.exports = {
  apps: [
    {
      name: 'xiansuo',
      cwd: '/opt/xiansuo/server',
      script: './node_modules/.bin/tsx',
      args: 'src/index.ts',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        HOST: '127.0.0.1',
        JWT_SECRET: 'CHANGE_THIS_TO_A_RANDOM_STRING_IN_PRODUCTION',
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
