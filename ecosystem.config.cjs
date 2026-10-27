// pm2 process definitions for Orbit's six services.
//   pm2 start ecosystem.config.cjs      # start all
//   pm2 restart ecosystem.config.cjs    # restart all
//   pm2 logs orbit-server               # tail one
//   pm2 save                            # persist across reboots (with pm2 startup)
// Environment comes from the shell / your .env file (read by config.mjs).
const node = process.execPath;
const mk = (name, script) => ({ name, script, interpreter: node, autorestart: true, max_restarts: 10, env: {} });

module.exports = {
  apps: [
    mk('orbit-server', 'server.mjs'),
    mk('orbit-usage', 'usage.mjs'),
    mk('orbit-models', 'models.mjs'),
    mk('orbit-skills', 'skills.mjs'),
    mk('orbit-push', 'push.mjs'),
    mk('orbit-explain', 'explain-service.mjs'),
  ],
};
