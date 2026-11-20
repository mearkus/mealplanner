// Renders the source images for app icons and splash screens into assets/ (dev-only helper).
// Then run: npx capacitor-assets generate   (see README → Android and iOS apps)
const { chromium } = require('playwright');
const GREEN = '#2f6b4f';
// The logo without its rounded-square background, drawn on a 512 grid.
const MARK = `<circle cx="256" cy="276" r="150" fill="#f6f4ef"/><circle cx="256" cy="276" r="104" fill="none" stroke="#e9a23b" stroke-width="18"/><path d="M118 96v100a30 30 0 0 0 60 0V96M148 96v300" stroke="#f6f4ef" stroke-width="20" stroke-linecap="round" fill="none"/><path d="M394 96c-34 20-44 70-44 110h44v190" stroke="#f6f4ef" stroke-width="20" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
const svg = (size, { bg, scale = 1 }) => {
  const s = (size / 512) * scale; const off = (size - 512 * s) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : ''}<g transform="translate(${off} ${off}) scale(${s})">${MARK}</g></svg>`;
};
(async () => {
  const b = await chromium.launch();
  const shot = async (name, size, opts) => {
    const p = await b.newPage({ viewport: { width: size, height: size } });
    await p.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(size, opts)}`);
    await p.screenshot({ path: `assets/${name}`, omitBackground: true });
    await p.close();
  };
  await shot('icon-only.png', 1024, { bg: GREEN, scale: 0.92 });          // iOS + legacy Android icon (OS rounds the corners)
  await shot('icon-foreground.png', 1024, { scale: 0.62 });               // Android adaptive icon: logo inside the safe zone
  await shot('icon-background.png', 1024, { bg: GREEN, scale: 0 });       // Android adaptive icon background
  await shot('splash.png', 2732, { bg: GREEN, scale: 0.28 });
  await shot('splash-dark.png', 2732, { bg: '#151a17', scale: 0.28 });
  await b.close();
  console.log('Wrote assets/*.png');
})();
