# Groceries

A one-file mobile grocery list (`site/index.html`) with real product photos and prices from Kroger, hosted on GitHub Pages. A small Cloudflare Worker (`worker/`) holds the Kroger API keys and proxies searches and images, so no keys ever reach the browser.

```
site/      the app (plain HTML/CSS/JS, no build) + PWA manifest and icons
worker/    Cloudflare Worker: /stores, /search, /img
tools/     make-icons.cjs (re-renders the PNG icons from site/icon.svg)
```

## Everyday updates

- **App:** edit `site/index.html`, commit, push. GitHub Actions republishes the site in about a minute.
- **Worker:** edit `worker/src/index.js`, then `cd worker && npx wrangler deploy`.

## One-time setup

1. **Kroger app**: at developer.kroger.com create an app (Production) with the `product.compact` scope.
2. **Worker**: put the Kroger ID and secret in `.env` (git-ignored) in this folder, then run
   ```sh
   node tools/deploy.mjs
   ```
   It logs in to Cloudflare if needed (opens a browser), deploys the Worker, pipes the two secrets in from `.env` without printing them, tests `/stores` and `/search` against the real Kroger API, writes the Worker URL into `API_DEFAULT` in `site/index.html`, and commits and pushes.
   To re-test a Worker any time: `node tools/deploy.mjs --check https://groceries-api.<you>.workers.dev`.
3. **GitHub Pages**: repo Settings → Pages → Source: **GitHub Actions**.
4. If the site's address changes, update `ALLOWED_ORIGIN` in `worker/wrangler.toml` and redeploy.

## Data

Everything is saved in the browser's `localStorage` (`grocery-v1`) on that device. Use ⚙ → **Export JSON** to back up or move to another phone, and **Import JSON** to restore.

Photo precedence: your own photo → the Kroger product you picked for the current store → a drawn illustration.

## Testing locally

```sh
cd worker
printf 'KROGER_CLIENT_ID=test-id\nKROGER_CLIENT_SECRET=test-secret\nKROGER_BASE=http://127.0.0.1:8789/v1\n' > .dev.vars
npm run mock &                     # fake Kroger API on :8789
npx wrangler dev --port 8787 &
cd ../site && python3 -m http.server 5500
# open http://localhost:5500/?api=http://127.0.0.1:8787
```
To test against the real Kroger API instead, put real values in `.dev.vars` and drop the `KROGER_BASE` line. `.dev.vars` is git-ignored.
