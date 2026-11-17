# PC Booking

Booking calendar for the group's GPU PCs, served from GitHub Pages. No build step: plain ES modules.

- **This repo is public** and contains no data. Bookings and the PC list live in the private repo [`ubi-coro/pc-bookings-data`](https://github.com/ubi-coro/pc-bookings-data); the page reads and writes them through the GitHub API with each visitor's own GitHub login.
- **Demo mode** (fake data, stored in your browser) runs when `githubAppClientId` in `src/config.js` is empty, or with `?demo` in the URL.

## Using it

- Press on an empty day in a PC's row and drag to book a range (or just click for one day). The new booking stays as a ghost behind the dialog and follows what you type.
- Grab a booking to move it, also onto another PC; it follows the pointer and a dashed outline shows where it will land. Drag its edges to change the dates. `Esc` mid-drag puts it back. Click it to edit or delete (with undo).
- Click a column header to sort; GPU sorts by VRAM. Drag the separators between column headers to resize (double-click resets); cells wrap instead of cutting off.
- Drag across dates in the day header (or click one) to show only PCs that are free then; preemptible bookings count as free. `Esc` clears it.
- The timeline scrolls endlessly; the arrows page through it.
- Preemptible bookings (striped) mean: others may stop my jobs if they need the PC.
- Keys: `N` new booking, `T` today, `←`/`→` page, `/` search, `Delete` on a focused booking.

## How it works

`bookings.json` is rewritten through the contents API on every change. Each write carries the file's current SHA, so if two people edit at once the second write gets a conflict, and the app re-applies its change on top of the fresh file instead of overwriting the other one.

Sign-in uses a GitHub App (scoped to *Contents: read & write* on the data repo only). The OAuth code-for-token exchange needs the client secret and isn't allowed from a browser, so `worker/oauth.js`, a ~40-line Cloudflare Worker, does just that step.

## Setup (once)

1. **Data repo.** Create the private repo `ubi-coro/pc-bookings-data` and push the contents of the data folder. Give the group write access (e.g. via a team).
2. **GitHub App.** Org settings → Developer settings → GitHub Apps → New:
   - Homepage URL and Callback URL: `https://ubi-coro.github.io/pc-booking/`
   - Webhook: off
   - Repository permissions → Contents: *Read and write*
   - Keep "Expire user authorization tokens" on (the app refreshes them).
   - After creating it: generate a client secret, then *Install App* on the org, **only** for `pc-bookings-data`.
3. **Worker.** In `worker/`, set `CLIENT_ID` in `wrangler.toml`, then:
   ```sh
   npx wrangler deploy
   npx wrangler secret put CLIENT_SECRET
   ```
4. **App.** Put the client ID and the Worker URL into `src/config.js`, push, and enable Pages (Settings → Pages → Deploy from branch `main`, folder `/`).

## Local development

```sh
python3 -m http.server 8000   # then open http://localhost:8000/?demo
```
