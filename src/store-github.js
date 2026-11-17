// The private data repo is the database: pcs.json is read-only here, bookings.json is rewritten on every change. Each write is a commit, which gives a free audit log.
const API = 'https://api.github.com';

export class AuthError extends Error {}

// UTF-8 safe base64 (names like "József" break plain btoa/atob).
const b64decode = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
const b64encode = s => btoa(Array.from(new TextEncoder().encode(s), b => String.fromCharCode(b)).join(''));

export function githubStore({ owner, repo, branch }, getToken) {
  async function gh(path, init = {}) {
    const token = await getToken();
    if (!token) throw new AuthError('Signed out');
    const r = await fetch(API + path, {
      ...init,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (r.status === 401) throw new AuthError('Session expired');
    return r;
  }

  async function read(file) {
    const r = await gh(`/repos/${owner}/${repo}/contents/${file}?ref=${branch}`);
    if (r.status === 404) throw new Error(`No access to ${owner}/${repo}. Ask an admin to add you (and to install the app on that repo).`);
    if (!r.ok) throw new Error(`Loading ${file} failed (${r.status})`);
    const j = await r.json();
    return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
  }

  return {
    async whoami() {
      const r = await gh('/user');
      if (!r.ok) throw new Error(`Loading profile failed (${r.status})`);
      const u = await r.json();
      return { login: u.login, name: u.name || u.login, avatar: u.avatar_url };
    },

    async load() {
      const [pcs, bookings] = await Promise.all([read('pcs.json'), read('bookings.json')]);
      return { pcs: pcs.data, bookings: bookings.data };
    },

    // `op` maps the current bookings array to the next one. On a SHA conflict (someone else committed in between) it is re-applied to the fresh state.
    async mutate(op, message) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const cur = await read('bookings.json');
        const next = op(cur.data);
        const r = await gh(`/repos/${owner}/${repo}/contents/bookings.json`, {
          method: 'PUT',
          body: JSON.stringify({
            message,
            branch,
            sha: cur.sha,
            content: b64encode(JSON.stringify(next, null, 2) + '\n'),
          }),
        });
        if (r.ok) return next;
        if (r.status !== 409) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.message || `Saving failed (${r.status})`);
        }
      }
      throw new Error('Too many simultaneous edits, please try again.');
    },
  };
}
