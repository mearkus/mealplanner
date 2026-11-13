// Renders the PNG app icons from icon.svg using the pre-installed Playwright Chromium (dev-only helper).
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const svg = fs.readFileSync('public/icon.svg', 'utf8');
  const browser = await chromium.launch();
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>body{margin:0}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`);
    await page.screenshot({ path: `public/icon-${size}.png`, omitBackground: true });
  }
  await browser.close();
})();
