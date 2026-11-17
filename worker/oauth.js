// Cloudflare Worker: swaps a GitHub OAuth code (or refresh token) for a user access token. The browser can't do this itself, because the request needs the client secret and github.com/login/oauth/access_token sends no CORS headers.
// Vars: CLIENT_ID, ALLOWED_ORIGIN (e.g. https://ubi-coro.github.io). Secret: CLIENT_SECRET (`npx wrangler secret put CLIENT_SECRET`).

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/token') return json({ error: 'not_found' }, 404);
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) return json({ error: 'forbidden_origin' }, 403);

    const { code, refresh_token } = await request.json().catch(() => ({}));
    const params = new URLSearchParams({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET });
    if (typeof code === 'string' && code) {
      params.set('code', code);
    } else if (typeof refresh_token === 'string' && refresh_token) {
      params.set('grant_type', 'refresh_token');
      params.set('refresh_token', refresh_token);
    } else {
      return json({ error: 'missing_code' }, 400);
    }

    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: params,
    });
    // GitHub answers 200 with an `error` field on failure; the client checks for it.
    return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
