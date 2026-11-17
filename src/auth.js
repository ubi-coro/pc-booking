// GitHub App user-to-server tokens via the web flow. The code→token exchange and the refresh both need the client secret, which lives in the Worker.
import { config } from './config.js';

const KEY = 'pcb.session';
const STATE = 'pcb.oauthState';

export function getSession() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}
function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}
export function signOut() {
  try { localStorage.removeItem(KEY); } catch {}
}

export function signIn() {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE, state);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.githubAppClientId);
  url.searchParams.set('redirect_uri', location.origin + location.pathname);
  url.searchParams.set('state', state);
  location.assign(url);
}

// Call on page load: finishes the redirect back from GitHub if there is one.
export async function completeSignIn() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (!code) return;
  history.replaceState(null, '', location.pathname);
  if (params.get('state') !== sessionStorage.getItem(STATE)) throw new Error('Sign-in failed (state mismatch), please try again.');
  sessionStorage.removeItem(STATE);
  save(await exchange({ code }));
}

async function exchange(body) {
  const r = await fetch(`${config.oauthProxy}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || !j.access_token) throw new Error(j.error_description || j.error || `Token exchange failed (${r.status})`);
  const now = Date.now();
  return {
    token: j.access_token,
    refresh: j.refresh_token ?? null,
    expires: j.expires_in ? now + j.expires_in * 1000 : null,
  };
}

// Refresh tokens are single-use, so concurrent callers must share one refresh.
let refreshing = null;

export async function accessToken() {
  const s = getSession();
  if (!s) return null;
  if (!s.expires || Date.now() < s.expires - 60_000) return s.token;
  if (!s.refresh) { signOut(); return null; }
  refreshing ??= exchange({ refresh_token: s.refresh })
    .then(next => { save(next); return next.token; })
    .catch(() => { signOut(); return null; })
    .finally(() => { refreshing = null; });
  return refreshing;
}
