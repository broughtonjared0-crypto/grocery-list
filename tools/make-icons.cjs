// Renders site/icon.svg to the PNG icons the manifest and iOS need.  node tools/make-icons.cjs
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const site = path.join(__dirname, '..', 'site');
  const svg = fs.readFileSync(path.join(site, 'icon.svg'), 'utf8');
  const b = await chromium.launch(); const p = await b.newPage();
  const shots = [['icon-192.png', 192, svg], ['icon-512.png', 512, svg],
    // iOS and maskable icons get a full-bleed square (the OS rounds the corners itself)
    ['apple-touch-icon.png', 180, svg.replace('rx="112"', 'rx="0"')],
    ['icon-maskable-512.png', 512, svg.replace('rx="112"', 'rx="0"').replace('<svg ', '<svg ').replace('viewBox="0 0 512 512"', 'viewBox="-56 -56 624 624"').replace('<rect width="512" height="512" rx="0"', '<rect x="-56" y="-56" width="624" height="624"')]];
  for (const [name, size, s] of shots) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${s}`);
    await p.screenshot({ path: path.join(site, name), omitBackground: true });
  }
  await b.close();
})();
