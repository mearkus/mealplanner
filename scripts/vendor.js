// Copies the browser builds of pdf.js and mammoth into public/vendor (run automatically by wrangler).
import fs from 'node:fs';
import path from 'node:path';

const out = path.resolve('public/vendor');
fs.mkdirSync(out, { recursive: true });
const copy = (from, to = path.basename(from)) => fs.cpSync(path.resolve('node_modules', from), path.join(out, to), { recursive: true });
copy('pdfjs-dist/build/pdf.min.mjs');
copy('pdfjs-dist/build/pdf.worker.min.mjs');
copy('pdfjs-dist/cmaps', 'cmaps');
copy('pdfjs-dist/standard_fonts', 'standard_fonts');
copy('mammoth/mammoth.browser.min.js');
console.log('Vendored pdf.js and mammoth into public/vendor');
