// Flow 1 timing for live-driver.cjs (documents/perf_baseline.md "Browser flows"): seed a 3-file C++ project, open main.cpp, time first diagnostic, hover and go-to-definition.
// Run: curl -s --data-binary @scripts/live-flow-open.js http://127.0.0.1:9444/run
const out = [];
const files = {
 'model.h': '#pragma once\n#include <string>\n#include <vector>\n#include <map>\nstruct Model {\n  std::vector<int> v;\n  std::map<std::string, int> m;\n  int compute(int x) const;\n};\n',
 'model.cpp': '#include "model.h"\nint Model::compute(int x) const {\n  int s = x;\n  for (int i : v) s += i;\n  return s;\n}\n',
 'main.cpp': '#include <iostream>\n#include "model.h"\nint main() {\n  Model mdl;\n  mdl.v = {1, 2, 3};\n  int bad = "oops";\n  std::cout << mdl.compute(4) << std::endl;\n  return 0;\n}\n',
};
await seed(files);
await p.evaluate(() => 0);
const t0 = Date.now();
const U = () => new Date().toISOString().slice(11, 23);
const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's @' + U();
out.push('seed done, t0 = ' + U());
await p.keyboard.press('Control+p'); await sleep(300); await p.keyboard.type('main.cpp'); await sleep(500); await p.keyboard.press('Enter');
out.push('opened main.cpp (t0, timer starts at Ctrl+P Enter)');
// diagnostics: squiggle in editor
let tDiag = null, tHover = null, tDef = null;
const hoverTry = async () => {
  const tok = p.locator('.view-lines span', { hasText: /^compute$/ }).first();
  if (await tok.count() === 0) return false;
  const b = await tok.boundingBox(); if (!b) return false;
  await p.mouse.move(5, 5); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
  await sleep(1200);
  const h = await p.evaluate(() => [...document.querySelectorAll('.monaco-hover-content')].map(e => e.innerText).join('|'));
  return h && !/Loading/i.test(h) && /compute|int/.test(h) ? h.slice(0, 80).replace(/\n/g, ' ') : false;
};
const defTry = async () => {
  const tok = p.locator('.view-lines span', { hasText: /^compute$/ }).first();
  const b = await tok.boundingBox(); if (!b) return false;
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await p.keyboard.press('F12'); await sleep(1500);
  const tab = await p.evaluate(() => (document.querySelector('.tab.active .label-name, .tab.active')||{}).innerText || '');
  return /model\.(h|cpp)/.test(tab) ? tab : false;
};
for (let i = 0; i < 150; i++) {
  if (tDiag === null && await p.evaluate(() => document.querySelectorAll('.squiggly-error').length) > 0) { tDiag = T(); out.push('first squiggle: ' + tDiag); }
  if (tDiag !== null && tHover === null) { const h = await hoverTry(); if (h) { tHover = T(); out.push('hover ok: ' + tHover + ' ' + h); } }
  if (tHover !== null && tDef === null) { const d = await defTry(); if (d) { tDef = T(); out.push('definition ok: ' + tDef + ' ' + d); break; } }
  await sleep(500);
}
out.push('end ' + T());
await shot('p1');
return out.join('\n');
