// Public values only: everything here ships to the browser.
export const config = {
  // Private repo holding pcs.json and bookings.json.
  dataRepo: { owner: 'ubi-coro', repo: 'pc-bookings-data', branch: 'main' },
  // Client ID of the GitHub App (Settings → Developer settings → GitHub Apps). Empty = demo mode.
  githubAppClientId: '',
  // Cloudflare Worker from worker/oauth.js that swaps the OAuth code for a token.
  oauthProxy: '',
};
