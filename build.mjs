import fs from 'fs'; import crypto from 'crypto';
const root = new URL('.', import.meta.url).pathname;
const PJ = root + 'node_modules/pdfjs-dist';
const rd = p => fs.readFileSync(root + p, 'utf8');
// Turn pdf.js ES modules into classic scripts: no import/export, no import.meta.
function classic(file, globalName) {
  let src = fs.readFileSync(PJ + '/legacy/build/' + file, 'utf8');
  const m = src.match(/export\s*\{([^}]*)\};?\s*$/);
  if (!m) throw new Error('no export block in ' + file);
  const props = m[1].split(',').map(x => x.trim()).filter(Boolean).map(x => { const [a, b] = x.split(/\s+as\s+/); return `${b || a}:${a}`; });
  src = src.slice(0, m.index) + (globalName ? `;globalThis.${globalName}={${props.join(',')}};` : ';');
  src = src.replace(/import\.meta\.url/g, '""');
  if (/\bimport\.meta\b|^\s*import\s|^\s*export\s/m.test(src)) throw new Error('module syntax left in ' + file);
  src = '(function(){\n' + src + '\n})();';
  return '\n' + src.replace(/<\/script/gi, '<\\/script') + '\n';
}
const pdfjs = classic('pdf.min.mjs', 'pdfjsLib');
const worker = classic('pdf.worker.min.mjs', null); // already sets globalThis.pdfjsWorker
const js = '\n' + rd('src/parser.js') + '\n' + rd('src/app.js') + '\n';
if (js.includes('</script')) throw new Error('script contains </script');
const h = s => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const csp = [`default-src 'none'`, `script-src ${h(pdfjs)} ${h(worker)} ${h(js)} blob:`, `worker-src blob:`, `style-src 'unsafe-inline'`,
  `img-src data: blob:`, `font-src data:`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `object-src 'none'`,
  `frame-src 'none'`, `media-src 'none'`, `manifest-src 'none'`].join('; ');
const version = JSON.parse(fs.readFileSync(PJ + '/package.json')).version;
const html = rd('src/index.html')
  .replace('{{CSP}}', () => csp).replace('{{CSS}}', () => rd('src/styles.css')).replace('{{PDFJS_VERSION}}', version)
  .replace('{{PDFJS}}', () => pdfjs).replace('{{PDFJS_WORKER}}', () => worker).replace('{{JS}}', () => js);
fs.mkdirSync(root + 'dist', { recursive: true });
fs.writeFileSync(root + 'dist/Tally.html', html);
console.log('built dist/Tally.html', (html.length / 1e6).toFixed(2) + ' MB');
