/**
 * Corrected brand kit built around the REAL WaPay logo (founder-supplied,
 * Downloads 2026-08-31): W mark (two slanted strokes + dot) + "WaPay"
 * wordmark, green #359853, raster-only source (no vector master exists).
 *
 * Outputs:
 *  - wapay-logo-1024-TM.png / -512-TM.png — the real logo with a small ™
 *    composited top-right of the wordmark (measured cap-top y=426, right
 *    edge x=969 on the 1024 master).
 *  - logo-pleasepayme[-TM].svg/.png — "Please Pay Me" wordmark in the SAME
 *    green and Inter SemiBold (the site face per the Lovable brief), so it
 *    matches the family. Type outlined to paths.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as fontkit from 'fontkit';
import { Resvg } from '@resvg/resvg-js';

const GREEN = '#359853';
const inter600 = fontkit.openSync('fonts/Inter-wght-600.ttf');

function layout(font, text, size) {
  const scale = size / font.unitsPerEm;
  const run = font.layout(text);
  let x = 0; const paths = [];
  for (let i = 0; i < run.glyphs.length; i++) {
    const g = run.glyphs[i], pos = run.positions[i];
    const d = g.path.toSVG();
    if (d) paths.push({ d, tx: x + pos.xOffset * scale, ty: -pos.yOffset * scale, s: scale });
    x += pos.xAdvance * scale;
  }
  return { paths, width: x };
}
const pathsToSvg = (paths, fill) => paths.map((p) =>
  `<path fill="${fill}" transform="translate(${p.tx.toFixed(2)},${p.ty.toFixed(2)}) scale(${p.s.toFixed(5)},-${p.s.toFixed(5)})" d="${p.d}"/>`).join('');

// ---------- 1. TM overlay onto the real raster logo ----------
function renderTm(capPx) {
  // TM at 26% of the wordmark cap height, drawn in the logo green.
  const tmSize = (capPx * 0.26 * inter600.unitsPerEm) / inter600.capHeight;
  const l = layout(inter600, 'TM', tmSize);
  const h = Math.ceil(capPx * 0.32), w = Math.ceil(l.width) + 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><g transform="translate(1,${(capPx * 0.26).toFixed(1)})">${pathsToSvg(l.paths, GREEN)}</g></svg>`;
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: w } }).render().asPng();
  return PNG.sync.read(png);
}

function compositeTm(srcPath, outPath, wordRight, wordCapTop, capPx) {
  const src = PNG.sync.read(readFileSync(srcPath));
  const tm = renderTm(capPx);
  const ox = wordRight + Math.round(capPx * 0.10);
  const oy = wordCapTop;
  // The source art runs nearly to the right edge — widen the canvas so the
  // TM is never clipped.
  const needW = Math.max(src.width, ox + tm.width + 16);
  const base = new PNG({ width: needW, height: src.height });
  for (let y = 0; y < src.height; y++)
    src.data.copy(base.data, y * needW * 4, y * src.width * 4, (y + 1) * src.width * 4);
  for (let y = 0; y < tm.height; y++) for (let x = 0; x < tm.width; x++) {
    const dx = ox + x, dy = oy + y;
    if (dx < 0 || dy < 0 || dx >= base.width || dy >= base.height) continue;
    const si = (y * tm.width + x) * 4, di = (dy * base.width + dx) * 4;
    const sa = tm.data[si + 3] / 255;
    if (sa === 0) continue;
    const da = base.data[di + 3] / 255, oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++)
      base.data[di + c] = Math.round((tm.data[si + c] * sa + base.data[di + c] * da * (1 - sa)) / (oa || 1));
    base.data[di + 3] = Math.round(oa * 255);
  }
  writeFileSync(outPath, PNG.sync.write(base));
  console.log('wrote', outPath);
}

// Measured on the 1024 master: wordmark cap top y=426, right edge x=969,
// cap height ≈ 604-426 minus descender… caps span 426..560 → ~134px.
compositeTm('/Users/nieuwoudtgresse/Downloads/wapay-logo-1024.png', 'out/wapay-logo-1024-TM.png', 969, 426, 134);

// ---------- 2. Please Pay Me wordmark in the family style ----------
function ppm(withTm) {
  const CAP = 200;
  const SIZE = (CAP * inter600.unitsPerEm) / inter600.capHeight;
  const l = layout(inter600, 'Please Pay Me', SIZE);
  let inner = `<g>${pathsToSvg(l.paths, GREEN)}</g>`;
  let totalW = l.width;
  if (withTm) {
    const tmSize = SIZE * 0.26;
    const t = layout(inter600, 'TM', tmSize);
    inner += `<g transform="translate(${(totalW + 14).toFixed(1)},${(-CAP + 0.26 * CAP).toFixed(1)})">${pathsToSvg(t.paths, GREEN)}</g>`;
    totalW += 14 + t.width;
  }
  const pad = 24, minY = -CAP - pad, maxY = 0.26 * SIZE + pad;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${minY} ${totalW + 2 * pad} ${maxY - minY}">\n${inner}\n</svg>\n`;
}

for (const [name, svg] of [['logo-pleasepayme', ppm(false)], ['logo-pleasepayme-TM', ppm(true)]]) {
  writeFileSync(`out/${name}.svg`, svg);
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 3000 } }).render().asPng();
  writeFileSync(`out/${name}.png`, png);
  console.log('wrote out/' + name + '.svg/.png');
}
