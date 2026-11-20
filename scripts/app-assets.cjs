// Renders the source images for app icons and splash screens into assets/ (dev-only helper).
// Then run: npx capacitor-assets generate   (see README → Android and iOS apps)
const { chromium } = require('playwright');
const GREEN = '#2f6b4f';
// The logo (plate with fork and knife) without its background, drawn on a 512 grid.
const MARK = `
  <circle cx="256" cy="262" r="112" fill="#f6f4ef"/>
  <circle cx="256" cy="262" r="80" fill="none" stroke="#dcd5c3" stroke-width="8"/>
  <g stroke="#f6f4ef" stroke-linecap="round" fill="none">
    <path d="M100 132v52M122 132v52M144 132v52" stroke-width="12"/>
    <path d="M100 184c0 22 10 34 22 34s22-12 22-34" stroke-width="12"/>
    <path d="M122 218v168" stroke-width="18"/>
    <path d="M390 386V132c26 14 34 66 26 120h-26" stroke-width="18" stroke-linejoin="round" fill="#f6f4ef"/>
  </g>`;
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
  await shot('icon-foreground.png', 1024, { scale: 0.72 });               // Android adaptive icon: whole logo inside the circular safe zone
  await shot('icon-background.png', 1024, { bg: GREEN, scale: 0 });       // Android adaptive icon background
  await shot('splash.png', 2732, { bg: GREEN, scale: 0.3 });
  await shot('splash-dark.png', 2732, { bg: '#151a17', scale: 0.3 });
  await b.close();
  console.log('Wrote assets/*.png');
})();
