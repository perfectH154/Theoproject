const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('./config');
const logger = require('./logger');
const { ensureDir } = require('./utils/fs');
require('./db');
const { ClaudePtyManager } = require('./services/claudePty');
const { createApiRouter } = require('./routes/api');
const { createWebSocketServer } = require('./websocket');
const { PushAgent } = require('./push-agent/scheduler');

ensureDir(config.dataDir);
ensureDir(config.uploadDir);
ensureDir(config.audioDir);
ensureDir(config.tmpDir);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

if (fs.existsSync(config.frontendDir)) {
  app.use('/chat', express.static(config.frontendDir, {
    index: 'index.html',
    fallthrough: true,
    maxAge: config.nodeEnv === 'production' ? '1h' : 0
  }));
  app.get('/chat/*', (req, res) => {
    res.sendFile(path.join(config.frontendDir, 'index.html'));
  });
  app.get('/', (req, res) => {
    res.redirect('/chat/');
  });
}

const claudeManager = new ClaudePtyManager();
claudeManager.start();
const pushAgent = new PushAgent();
pushAgent.start();

app.use(createApiRouter(claudeManager, pushAgent));

const server = http.createServer(app);
createWebSocketServer(server, claudeManager);

server.listen(config.port, config.host, () => {
  logger.info('Bridge listening', { host: config.host, port: config.port });
});

function shutdown(signal) {
  logger.info('收到退出信号', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  logger.error('uncaughtException', { message: error.message, stack: error.stack });
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  logger.error('unhandledRejection', { message: error?.message || String(error), stack: error?.stack });
});
