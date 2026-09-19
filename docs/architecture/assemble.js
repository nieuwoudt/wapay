// Assembles pay-agent-architecture.html from the template, the SVG fragments and rows.json (+ claims.json when present)
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let html = fs.readFileSync(path.join(dir, 'pay-agent-architecture.template.html'), 'utf8');
const rows = JSON.parse(fs.readFileSync(path.join(dir, 'rows.json'), 'utf8'));
const svg = (n) => fs.readFileSync(path.join(dir, n), 'utf8').trim();
html = html.replace('<!--TODAY_SVG-->', svg('today-diagram.svg'));
html = html.replace('<!--TARGET_SVG-->', svg('target-diagram.svg'));
html = html.replace('<!--COMPARE_SVG-->', svg('compare-diagram.svg'));
html = html.replace('<!--MEMORY_SVG-->', svg('memory-diagram.svg'));
const optional = (n) => (fs.existsSync(path.join(dir, n)) ? svg(n) : '<p>The phase map is being drawn.</p>');
html = html.replace('<!--PHASE_MAP_SVG-->', optional('phase-map.svg'));
html = html.replace('<!--PHASE_MAP_CAPTION-->', esc(rows.phaseMapCaption || ''));
html = html.replace('<!--WHERE_WE_ARE-->', rows.whereWeAre ? '  <div class="card accent"><span class="kicker">Where we are</span>' + rows.whereWeAre.map((p) => '<p>' + esc(p) + '</p>').join('') + '</div>\n' : '');
const gradeClass = (g) => (['A'].includes(g) ? 'keep' : ['B', 'C'].includes(g) ? 'add' : ['D'].includes(g) ? 'change' : 'drop');
html = html.replace('<!--PRODUCTS_NOTE-->', esc(rows.productsNote || ''));
html = html.replace('<!--PRODUCT_ROWS-->', (rows.products || []).map((r) => '    <tr><td><b>' + esc(r[0]) + '</b></td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td><td><span class="pill ' + gradeClass(r[4]) + '">' + esc(r[4]) + '</span></td><td>' + esc(r[5]) + '</td></tr>').join('\n'));
html = html.replace('<!--FOUNDER_TEST_ROWS-->', (rows.founderTests || []).map((r) => '    <tr><td class="num">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td><td>' + esc(r[4]) + '</td></tr>').join('\n'));
html = html.replace('<!--SEQUENCE_ROWS-->', rows.sequence.map(r => `    <tr><td class="num">${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td class="num">${esc(r[3])}</td></tr>`).join('\n'));
html = html.replace('<!--PLAN_ROWS-->', rows.plan.map(r => `    <tr><td><b>${esc(r[0])}</b></td><td class="num">${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td></tr>`).join('\n'));
html = html.replace('<!--HANDOVER_ROWS-->', rows.handover.map(r => `    <tr><td>${esc(r[0])}</td><td><span class="pill ${esc(r[1])}">${esc(r[1])}</span></td><td>${esc(r[2])}</td></tr>`).join('\n'));
html = html.replace('<!--FIX_NOW-->', rows.fixNow.map(r => `    <li>${r}</li>`).join('\n'));
html = html.replace('<!--DISAGREE-->', rows.disagree.map(r => `    <li>${r}</li>`).join('\n'));
let claims = [];
try { claims = JSON.parse(fs.readFileSync(path.join(dir, 'claims.json'), 'utf8')); } catch (e) {}
html = html.replace('<!--CLAIM_ROWS-->', claims.length
  ? claims.map(c => `    <tr><td>${esc(c.claim)}</td><td><span class="pill ${esc(c.cls)}">${esc(c.result)}</span></td><td>${esc(c.note)}</td></tr>`).join('\n')
  : '    <tr><td colspan="3">Verification still running.</td></tr>');
fs.writeFileSync(path.join(dir, 'pay-agent-architecture.html'), html);
console.log('assembled', html.length, 'chars;', claims.length, 'claims');
