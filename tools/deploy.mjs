// One-command Worker setup. Run from the repo root on your own computer:
//
//   node tools/deploy.mjs                 deploy the Worker, set the Kroger secrets from .env,
//                                         test it, point site/index.html at it, commit + push
//   node tools/deploy.mjs --check <url>   only test a running Worker (e.g. http://127.0.0.1:8787)
//
// .env must contain KROGER_CLIENT_ID=… and KROGER_CLIENT_SECRET=…  The values are never printed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerDir = path.join(root, 'worker');
const sitePage = path.join(root, 'site', 'index.html');
const PAGES_ORIGIN = 'https://broughtonjared0-crypto.github.io';

const say = m => console.log(`\n▸ ${m}`);
const die = m => { console.error(`\n✗ ${m}`); process.exit(1); };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: workerDir, shell: process.platform === 'win32', encoding: 'utf8', ...opts });

async function check(base) {
  base = base.replace(/\/$/, '');
  const get = async p => {
    const r = await fetch(base + p, { headers: { Origin: PAGES_ORIGIN } });
    let body = null; try { body = await r.json(); } catch {}
    if (!r.ok) die(`${p} → ${r.status} ${body && body.error ? body.error : ''}`);
    return body;
  };
  say('Checking /stores?zip=40475');
  const stores = await get('/stores?zip=40475');
  if (!stores.length) die('No stores came back for 40475');
  console.log(`  ${stores.length} stores, first: ${stores[0].name} (${stores[0].chain}) ${stores[0].address} [${stores[0].locationId}]`);
  say('Checking /search?q=2% milk');
  const items = await get(`/search?q=${encodeURIComponent('2% milk')}&locationId=${stores[0].locationId}`);
  if (!items.length) die('Search returned nothing');
  const priced = items.filter(i => i.price != null).length, pics = items.filter(i => i.image).length, sale = items.filter(i => i.promo).length;
  console.log(`  ${items.length} products · ${priced} with prices · ${pics} with photos · ${sale} on sale`);
  console.log(`  first: ${items[0].name} · ${items[0].size} · $${items[0].price}${items[0].promo ? ` (sale $${items[0].promo})` : ''}`);
  const withPic = items.find(i => i.image);
  if (!withPic) die('No product photos in the results');
  const img = await fetch(withPic.image);
  console.log(`  photo: ${img.status} ${img.headers.get('content-type')}`);
  if (!img.ok) die('The image proxy did not return the photo');
  if (!priced) console.log('  ⚠ no prices — check that the Kroger app has access to the Product API for this store');
  console.log('\n✓ Worker looks good');
}

if (process.argv[2] === '--check') {
  if (!process.argv[3]) die('Usage: node tools/deploy.mjs --check <worker url>');
  await check(process.argv[3]);
  process.exit(0);
}

// 1. Read .env without echoing anything.
const envPath = path.join(root, '.env');
if (!fs.existsSync(envPath)) die('Make a file called .env in the repo folder with:\n  KROGER_CLIENT_ID=...\n  KROGER_CLIENT_SECRET=...');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) die('.env needs both KROGER_CLIENT_ID and KROGER_CLIENT_SECRET filled in');

// 2. Tools + login.
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) die(`Node ${process.versions.node} is too old; install Node 20 or newer from nodejs.org`);
say('Installing wrangler');
if (run('npm', ['install', '--no-audit', '--no-fund'], { stdio: 'inherit' }).status !== 0) die('npm install failed');
const who = run('npx', ['wrangler', 'whoami']);
if (!/logged in/i.test(who.stdout + who.stderr) || /not authenticated/i.test(who.stdout + who.stderr)) {
  say('Logging in to Cloudflare (a browser window opens)');
  if (run('npx', ['wrangler', 'login'], { stdio: 'inherit' }).status !== 0) die('wrangler login failed');
}

// 3. Deploy (interactive the first time, in case Cloudflare asks you to pick a workers.dev name).
say('Deploying the Worker');
if (run('npx', ['wrangler', 'deploy'], { stdio: 'inherit' }).status !== 0) die('wrangler deploy failed');

// 4. Secrets, piped in so they never show on screen.
for (const k of ['KROGER_CLIENT_ID', 'KROGER_CLIENT_SECRET']) {
  say(`Setting secret ${k}`);
  const r = run('npx', ['wrangler', 'secret', 'put', k], { input: env[k], stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) die(`Could not set ${k}`);
}

// 5. Find the Worker URL (a second deploy is quick and prints it).
const again = run('npx', ['wrangler', 'deploy']);
const url = ((again.stdout + again.stderr).match(/https:\/\/[a-z0-9.-]+\.workers\.dev/) || [])[0];
if (!url) die('Deployed, but could not read the workers.dev URL. Put it in API_DEFAULT in site/index.html by hand.');
console.log(`  Worker URL: ${url}`);

// 6. Test it for real.
await new Promise(r => setTimeout(r, 3000));
await check(url);

// 7. Point the site at it and publish.
const page = fs.readFileSync(sitePage, 'utf8');
const updated = page.replace(/const API_DEFAULT = '[^']*';/, `const API_DEFAULT = '${url}';`);
if (updated !== page) {
  fs.writeFileSync(sitePage, updated);
  say('Publishing the site with the Worker URL');
  const git = (...a) => spawnSync('git', a, { cwd: root, stdio: 'inherit' }).status === 0;
  if (!(git('add', 'site/index.html') && git('commit', '-m', 'Point the app at the deployed Worker') && git('push'))) {
    console.log('  Commit/push did not finish — run: git add site/index.html && git commit -m "Set Worker URL" && git push');
  }
} else console.log('\nsite/index.html already points at this Worker.');
console.log(`\n✓ Done. App: ${PAGES_ORIGIN}/grocery-list/  (if Pages is turned on)`);
