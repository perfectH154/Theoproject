const webpush = require('web-push');
const config = require('../config');
const logger = require('../logger');
const { getPushSubscriptions, markPushOk, markPushFail } = require('../db');

function configureWebPush() {
  if (!config.push.vapidPublicKey || !config.push.vapidPrivateKey) return false;
  webpush.setVapidDetails(config.push.vapidSubject, config.push.vapidPublicKey, config.push.vapidPrivateKey);
  return true;
}

async function notifyAll(text) {
  if (!configureWebPush()) {
    throw new Error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY 未配置');
  }
  const subs = getPushSubscriptions();
  let ok = 0;
  let fail = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      }, JSON.stringify({
        title: 'Théo',
        body: text.slice(0, 120),
        url: '/chat/'
      }));
      markPushOk(sub.id);
      ok += 1;
    } catch (error) {
      logger.warn('Web Push 发送失败', { id: sub.id, message: error.message });
      markPushFail(sub.id);
      fail += 1;
    }
  }
  return { ok, fail, total: subs.length };
}

module.exports = { configureWebPush, notifyAll };
