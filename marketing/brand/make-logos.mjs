/**
 * WaPay / Please Pay Me logo kit generator.
 *
 * Design system (from marketing/guides/wapay_design.py — the documented
 * wapay.co.za tokens): emerald #1FA867, emerald-dark #0C885E, ink #1D2026.
 * Family rule: the word "Pay" is always emerald; every other letter is ink.
 * Marks: a speech bubble (the product IS a chat) — W stroke for WaPay,
 * outlined Archivo R (rand request) for Please Pay Me.
 *
 * All wordmark type is OUTLINED to paths (opentype.js), so the SVG masters
 * are self-contained — no font dependency for the designer.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as fontkit from 'fontkit';
import { Resvg } from '@resvg/resvg-js';

const EMERALD = '#1FA867', EMERALD_DARK = '#0C885E', INK = '#1D2026', GRAY = '#6B7280';

const archivo800 = fontkit.openSync('fonts/Archivo-wght-800.ttf');
const archivo700 = fontkit.openSync('fonts/Archivo-wght-700.ttf');

const upem = archivo800.unitsPerEm;
const capUnits = archivo800.capHeight || 0.72 * upem;
const CAP = 200;                            // wordmark cap height in master units
const SIZE = (CAP * upem) / capUnits;       // font size that yields that cap height
const TM_SIZE = SIZE * 0.26;                // "little TM" — identical on every lockup

function layout(font, text, size) {
  // fontkit shaping: correct kerning, robust glyf parsing. Glyph paths are
  // y-up in font units -> flip with scale(s,-s) per glyph.
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

function pathsToSvg(paths, fill) {
  return paths.map((p) =>
    `<path fill="${fill}" transform="translate(${p.tx.toFixed(2)},${p.ty.toFixed(2)}) scale(${p.s.toFixed(5)},-${p.s.toFixed(5)})" d="${p.d}"/>`).join('');
}

function seg(text, font, size) {
  return { d: font.getPath(text, 0, 0, size, { kerning: true }).toPathData(3),
           adv: font.getAdvanceWidth(text, size, { kerning: true }) };
}

/** Word made of colored segments, baseline y=0, x from 0. Returns svg + width. */
function wordmark(segments) {
  let x = 0; const parts = [];
  for (const [text, color] of segments) {
    const l = layout(archivo800, text, SIZE);
    parts.push(`<g transform="translate(${x.toFixed(2)},0)">${pathsToSvg(l.paths, color)}</g>`);
    x += l.width;
  }
  return { svg: parts.join('\n  '), width: x };
}

function tmAt(x) {
  // Top-aligned with the caps: TM cap height = 0.26*CAP, so its baseline sits
  // that far below the cap line.
  const y = -CAP + 0.26 * CAP;
  const l = layout(archivo700, 'TM', TM_SIZE);
  return { svg: `<g transform="translate(${x.toFixed(2)},${y.toFixed(2)})">${pathsToSvg(l.paths, GRAY)}</g>`,
           width: l.width };
}

/** The speech-bubble mark in a local 512 box (bubble 20..428 + tail to 500). */
function bubble(inner, gradId) {
  return `<defs><linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" x1="32" y1="20" x2="480" y2="428">
    <stop offset="0" stop-color="${EMERALD}"/><stop offset="1" stop-color="${EMERALD_DARK}"/>
  </linearGradient></defs>
  <rect x="32" y="20" width="448" height="408" rx="118" fill="url(#${gradId})"/>
  <path fill="url(#${gradId})" d="M96 380 L96 500 Q98 512 112 502 L236 424 Z"/>
  ${inner}`;
}

const W_STROKE = `<path d="M150 146 L205 302 L256 182 L307 302 L362 146" fill="none" stroke="#FFFFFF" stroke-width="54" stroke-linecap="round" stroke-linejoin="round"/>`;

function rGlyph() {
  const rSize = (210 * upem) / capUnits;                       // cap 210 in 512 box
  const l = layout(archivo800, 'R', rSize);
  const x = (512 - l.width) / 2 + 6;
  const y = 224 + 105;                                          // centered on bubble body
  return `<g transform="translate(${x.toFixed(2)},${y.toFixed(2)})">${pathsToSvg(l.paths, '#FFFFFF')}</g>`;
}

function svgDoc(inner, minX, minY, w, h) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}">\n${inner}\n</svg>\n`;
}

/** Full lockup: mark + wordmark (+ optional TM). */
function lockup({ markInner, gradId, segments, tm }) {
  const MARK_H = 340;                                           // bubble+tail height
  const s = MARK_H / 480;                                       // local 480 tall (20..500)
  const markW = 448 * s;
  const wordCenter = -CAP / 2;                                  // visual center of caps
  const markTop = wordCenter - MARK_H / 2;
  const markTx = 0 - 32 * s;                                    // bubble left edge at x=0
  const markTy = markTop - 20 * s;
  const gap = 64;
  const wm = wordmark(segments);
  const wordX = markW + gap;
  let inner = `<g transform="translate(${markTx.toFixed(2)},${markTy.toFixed(2)}) scale(${s.toFixed(4)})">${bubble(markInner, gradId)}</g>\n  <g transform="translate(${wordX},0)">\n  ${wm.svg}\n  </g>`;
  let totalW = wordX + wm.width;
  if (tm) {
    const t = tmAt(0);
    inner += `\n  <g transform="translate(${totalW + 12},0)">${t.svg}</g>`;
    totalW += 12 + t.width;
  }
  // Bounds: mark spans markTop..markTop+MARK_H; words have descenders (~0.24*SIZE)
  const pad = 24;
  const minY = markTop - pad;
  const maxY = Math.max(markTop + MARK_H, 0.26 * SIZE) + pad;
  return svgDoc(inner, -pad, minY, totalW + 2 * pad, maxY - minY);
}

mkdirSync('out', { recursive: true });

const files = {
  'logo-wapay': lockup({ markInner: W_STROKE, gradId: 'gw1',
    segments: [['Wa', INK], ['Pay', EMERALD]], tm: false }),
  'logo-wapay-TM': lockup({ markInner: W_STROKE, gradId: 'gw2',
    segments: [['Wa', INK], ['Pay', EMERALD]], tm: true }),
  'logo-pleasepayme': lockup({ markInner: rGlyph(), gradId: 'gp1',
    segments: [['Please ', INK], ['Pay', EMERALD], [' Me', INK]], tm: false }),
  'logo-pleasepayme-TM': lockup({ markInner: rGlyph(), gradId: 'gp2',
    segments: [['Please ', INK], ['Pay', EMERALD], [' Me', INK]], tm: true }),
  'mark-wapay': svgDoc(bubble(W_STROKE, 'gm1'), 0, 0, 512, 512),
  'mark-pleasepayme': svgDoc(bubble(rGlyph(), 'gm2'), 0, 0, 512, 512),
};

for (const [name, svg] of Object.entries(files)) {
  writeFileSync(`out/${name}.svg`, svg);
  const width = name.startsWith('mark-') ? 1024 : 3000;
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
  writeFileSync(`out/${name}.png`, png);
  console.log(name, '->', svg.length, 'bytes svg,', png.length, 'bytes png');
}
