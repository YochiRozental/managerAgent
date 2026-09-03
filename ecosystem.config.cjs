module.exports = {
  apps: [
    {
      name: "whatsapp-agent",
      script: "node_modules/tsx/dist/cli.mjs",
      args: ["src/index.ts"],
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      env: { NODE_ENV: "production" },
    },
    {
      // חלונית העובד / העוזר התפעולי — רצה כל הזמן, מרימה מחדש על קריסה או ריבוט (עם pm2 startup)
      name: "ops-window",
      script: "node_modules/tsx/dist/cli.mjs",
      args: ["src/server/index.ts"],
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      env: { NODE_ENV: "production", PORT: "3001" },
    },
  ],
};
