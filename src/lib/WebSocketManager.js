const HEARTBEAT_INTERVAL_MS = 28_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 10_000;

function isStandalonePwa() {
  return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function log(message, meta = {}) {
  console.info('[TheoWS]', message, {
    standalone: isStandalonePwa(),
    visibility: document.visibilityState,
    online: navigator.onLine,
    ...meta
  });
}

export class WebSocketManager {
  constructor({ getUrl, onOpen, onClose, onError, onMessage }) {
    this.getUrl = getUrl;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onError = onError;
    this.onMessage = onMessage;
    this.ws = null;
    this.manualClose = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectAttempts = 0;
    this.lastSeenAt = 0;
    this.lastUrl = '';
    this.boundEvents = [];
    this.pageHidden = false;
  }

  connect() {
    if (!navigator.onLine) {
      log('skip connect while offline');
      return;
    }
    if (this.pageHidden || document.visibilityState === 'hidden') {
      log('skip connect while page hidden');
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      log('skip duplicate connect', { readyState: this.ws.readyState, url: this.lastUrl });
      return;
    }

    let url;
    try {
      url = this.getUrl();
    } catch (error) {
      log('connect failed before opening socket', { error: error.message });
      this.onError?.(error);
      this.scheduleReconnect();
      return;
    }
    this.lastUrl = url;
    this.manualClose = false;
    this.clearReconnectTimer();
    log('connect', { url });

    const ws = new WebSocket(url);
    this.ws = ws;
    this.lastSeenAt = Date.now();

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempts = 0;
      this.lastSeenAt = Date.now();
      log('onopen', { url });
      this.startHeartbeat();
      this.onOpen?.();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this.lastSeenAt = Date.now();
      this.onMessage?.(event);
    };

    ws.onerror = (event) => {
      if (this.ws !== ws) return;
      log('onerror', { url });
      this.onError?.(event);
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      log('onclose', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        manualClose: this.manualClose
      });
      this.stopHeartbeat();
      this.ws = null;
      this.onClose?.(event);
      if (!this.manualClose && !this.pageHidden && document.visibilityState !== 'hidden') this.scheduleReconnect();
    };
  }

  disconnect() {
    this.manualClose = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    if (this.ws) {
      log('disconnect', { readyState: this.ws.readyState });
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
  }

  reconnect() {
    if (!navigator.onLine) {
      log('reconnect postponed: offline');
      return;
    }
    if (this.pageHidden || document.visibilityState === 'hidden') {
      log('reconnect postponed: page hidden');
      return;
    }
    if (this.isConnected() && !this.isStale()) {
      log('reconnect skipped: alive');
      return;
    }
    this.forceReconnect('reconnect');
  }

  forceReconnect(reason = 'forceReconnect') {
    log('forceReconnect', { reason, readyState: this.ws?.readyState ?? null });
    this.manualClose = false;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close(4000, reason);
      } catch {
        // 旧连接已经损坏时直接放弃，下一行会新建连接。
      }
    }
    this.connect();
  }

  send(payload) {
    if (!this.isConnected()) {
      log('send failed: not connected', { readyState: this.ws?.readyState ?? null });
      return false;
    }
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return true;
  }

  isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  isStale() {
    return Date.now() - this.lastSeenAt > HEARTBEAT_TIMEOUT_MS;
  }

  bindLifecycleEvents() {
    if (this.boundEvents.length) return;

    const onVisibility = () => {
      log('visibilitychange');
      if (document.visibilityState === 'visible') {
        this.pageHidden = false;
        if (!this.isConnected()) this.reconnect();
        else if (this.isStale()) this.forceReconnect('visible heartbeat timeout');
      } else {
        this.pageHidden = true;
        this.clearReconnectTimer();
      }
    };

    const onPageShow = (event) => {
      log('pageshow', { persisted: event.persisted === true });
      this.pageHidden = false;
      if (event.persisted === true) this.forceReconnect('pageshow persisted');
      else this.reconnect();
    };

    const onPageHide = () => {
      log('pagehide');
      this.pageHidden = true;
      this.clearReconnectTimer();
    };

    const onOnline = () => {
      log('online');
      window.setTimeout(() => this.reconnect(), 500);
    };

    const onOffline = () => {
      log('offline');
    };

    const onFocus = () => {
      log('focus');
      if (!this.isConnected()) this.reconnect();
      else if (this.isStale()) this.forceReconnect('focus heartbeat timeout');
    };

    this.boundEvents = [
      ['visibilitychange', document, onVisibility],
      ['pageshow', window, onPageShow],
      ['pagehide', window, onPageHide],
      ['online', window, onOnline],
      ['offline', window, onOffline],
      ['focus', window, onFocus]
    ];

    for (const [name, target, handler] of this.boundEvents) {
      target.addEventListener(name, handler);
    }

    log('lifecycle listeners bound', { url: this.lastUrl });
  }

  unbindLifecycleEvents() {
    for (const [name, target, handler] of this.boundEvents) {
      target.removeEventListener(name, handler);
    }
    this.boundEvents = [];
  }

  destroy() {
    this.unbindLifecycleEvents();
    this.disconnect();
  }

  scheduleReconnect() {
    this.clearReconnectTimer();
    if (!navigator.onLine) {
      log('scheduleReconnect skipped: offline');
      return;
    }
    if (this.pageHidden || document.visibilityState === 'hidden') {
      log('scheduleReconnect skipped: page hidden');
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(this.reconnectAttempts * 1000, MAX_RECONNECT_DELAY_MS);
    log('scheduleReconnect', { attempts: this.reconnectAttempts, delay });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.isConnected()) return;
      if (this.isStale()) {
        log('heartbeat timeout', { lastSeenAt: this.lastSeenAt, timeoutMs: HEARTBEAT_TIMEOUT_MS });
        this.forceReconnect('heartbeat timeout');
        return;
      }
      log('heartbeat ping');
      this.send({ type: 'ping', content: 'heartbeat', meta: { ts: Date.now() } });
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
