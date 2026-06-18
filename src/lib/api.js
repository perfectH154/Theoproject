export function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readApiError(res) {
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // 非 JSON 错误也要保留原始文本，方便手机上排查。
  }
  const error = new Error(data?.error || `${res.status} ${text}`);
  error.status = res.status;
  error.data = data;
  error.approvalRequired = Boolean(data?.approvalRequired);
  error.tool = data?.tool;
  return error;
}

export async function apiGet(baseUrl, path, token) {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders(token) });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function apiPost(baseUrl, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function apiUpload(baseUrl, path, token, formData) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(token),
    body: formData
  });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function apiPatch(baseUrl, path, token, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function apiDelete(baseUrl, path, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: authHeaders(token)
  });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export async function importEpub(baseUrl, token, file) {
  const res = await fetch(`${baseUrl}/api/books/import-epub`, {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/octet-stream',
      'X-Filename': encodeURIComponent(file.name)
    },
    body: file
  });
  if (!res.ok) throw await readApiError(res);
  return res.json();
}

export function wsUrl(baseUrl, token, sessionId, conversationId) {
  const explicitWsUrl = import.meta.env?.VITE_WS_URL || window.__THEO_WS_URL__;
  const url = explicitWsUrl ? new URL(explicitWsUrl, window.location.origin) : new URL(baseUrl || window.location.origin, window.location.origin);
  if (!explicitWsUrl) {
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  }
  if (window.location.protocol === 'https:' && url.protocol !== 'wss:') {
    throw new Error(`HTTPS 页面不能连接非安全 WebSocket：${url.toString()}`);
  }
  url.pathname = '/ws';
  url.searchParams.set('token', token);
  url.searchParams.set('session_id', sessionId || 'default');
  url.searchParams.set('conversation_id', conversationId || 'default');
  return url.toString();
}
