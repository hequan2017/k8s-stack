/* api.js — thin fetch wrapper with optional bearer token */
(function () {
  const TOKEN_KEY = 'kubestack_token';
  const AUTH_KEY = 'kubestack_auth_enabled';

  async function request(method, path, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const resp = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
    if (resp.status === 401 && !path.startsWith('/api/login')) {
      localStorage.removeItem(TOKEN_KEY);
      window.dispatchEvent(new CustomEvent('auth-expired'));
      throw new Error('登录已过期');
    }
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!resp.ok) {
      const msg = (data && data.error) || ('HTTP ' + resp.status);
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    return data;
  }

  window.API = {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    put: (p, b) => request('PUT', p, b),
    patch: (p, b) => request('PATCH', p, b),
    del: (p) => request('DELETE', p),
    login: async (username, password) => {
      const r = await request('POST', '/api/login', { username, password });
      if (r.token) localStorage.setItem(TOKEN_KEY, r.token);
      localStorage.setItem(AUTH_KEY, r.authEnabled ? '1' : '0');
      return r;
    },
    hasToken: () => !!localStorage.getItem(TOKEN_KEY),
    token: () => localStorage.getItem(TOKEN_KEY) || '',
    authWasEnabled: () => localStorage.getItem(AUTH_KEY) === '1',
    logout: () => localStorage.removeItem(TOKEN_KEY),
  };
})();
