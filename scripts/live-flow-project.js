// Project-parameterized browser flows for live-driver.cjs (documents/perf_baseline.md "Browser flows by project").
// The driver takes only a script body, so prefix a config: scripts/live-flow-project.sh does it.
//   CFG = { mode: 'warm'|'open'|'edit', src, include (regex source), exclude (regex source), settings: {...},
//           open, prependBad, hoverTok, defTab (regex source), leaf, header, runs }
// warm: seed, open `open`, wait until clangd finished its background index.
// open: flow 1, seed a file with a deliberate error, time first squiggle, hover and go-to-definition from Ctrl+P Enter.
// edit: flow 2, Build C++ (first, unchanged, leaf edit x runs, header edit x runs); completion is build.log's mtime.
const out = [];
const U = () => new Date().toISOString().slice(11, 23);
try {
const inc = new RegExp(CFG.include), exc = CFG.exclude ? new RegExp(CFG.exclude) : null;
const settings = JSON.stringify(CFG.settings, null, 1);
const extra = { '.vscode/settings.json': settings, ...(CFG.extra || {}) };
const seeded = await seedDir(CFG.src, { include: r => inc.test(r) && !(exc && exc.test(r)), extra,
  patch: CFG.mode === 'open' || CFG.mode === 'warm' ? { [CFG.open]: t => CFG.prependBad + t } : {} });
out.push('seeded ' + seeded.files + ' files, ' + (seeded.bytes / 1e6).toFixed(1) + ' MB');
const openFile = async (name) => { await p.keyboard.press('Escape'); await sleep(200); await p.keyboard.press('Control+p'); await sleep(300); await p.keyboard.type(name); await sleep(600); await p.keyboard.press('Enter'); };
// A tab restored from the previous seed can steal focus after Ctrl+P; reopen until the wanted file is the active tab.
const activeTab = () => p.evaluate(() => (document.querySelector('.tab.active') || {}).innerText || '');
const ensureOpen = async (name) => {
  for (let i = 0; i < 4; i++) { await openFile(name); await sleep(2000); if ((await activeTab()).includes(name.split('/').pop())) { return; } }
};
if (CFG.mode === 'warm') {
  await ensureOpen(CFG.open);
  let seen = false, quiet = 0; const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    const s = await p.evaluate(() => (document.querySelector('.part.statusbar') || {}).innerText || '');
    const idx = /index/i.test(s);
    if (idx) { seen = true; quiet = 0; } else { quiet++; }
    if ((seen && quiet >= 10) || (!seen && quiet >= 80)) { break; }
    await sleep(1000);
  }
  out.push('warm: index ' + (seen ? 'ran' : 'never seen') + ', done after ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
} else if (CFG.mode === 'open') {
  const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
  await ensureOpen(CFG.open);
  await sleep(300); await p.mouse.click(700, 300); await p.keyboard.press('Control+Home'); // the editor restores the old scroll position
  const tokLoc = () => p.locator('.view-lines span', { hasText: new RegExp('^' + CFG.hoverTok + '$') }).first();
  const hoverTry = async () => {
    const tok = tokLoc(); if (await tok.count() === 0) { return false; }
    const b = await tok.boundingBox(); if (!b) { return false; }
    await p.mouse.move(5, 5); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 }); await sleep(1200);
    const h = await p.evaluate(() => [...document.querySelectorAll('.monaco-hover-content')].map(e => e.innerText).join('|'));
    return h && !/Loading/i.test(h) && h.includes(CFG.hoverTok) ? h.slice(0, 80).replace(/\n/g, ' ') : false;
  };
  const defTry = async () => {
    const tok = tokLoc(); const b = await tok.boundingBox(); if (!b) { return false; }
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.keyboard.press('F12'); await sleep(1500);
    const tab = await p.evaluate(() => (document.querySelector('.tab.active .label-name, .tab.active') || {}).innerText || '');
    return new RegExp(CFG.defTab).test(tab) ? tab : false;
  };
  let tDiag = null, tHover = null, tDef = null;
  while (Date.now() - t0 < 150000) {
    if (tDiag === null && await p.evaluate(() => document.querySelectorAll('.squiggly-error').length) > 0) { tDiag = T(); out.push('first squiggle: ' + tDiag); }
    if (tDiag !== null && tHover === null) { const h = await hoverTry(); if (h) { tHover = T(); out.push('hover ok: ' + tHover + ' ' + h); } }
    if (tHover !== null && tDef === null) { const d = await defTry(); if (d) { tDef = T(); out.push('definition ok: ' + tDef + ' ' + d); break; } }
    await sleep(500);
  }
  if (tDef === null) { out.push('INCOMPLETE diag=' + tDiag + ' hover=' + tHover); }
  out.push('end ' + T());
  await shot('open-' + CFG.name);
} else {
  const readLog = () => p.evaluate(async () => {
    const root = await navigator.storage.getDirectory(); let d;
    try { d = await (await (await root.getDirectoryHandle('proj')).getDirectoryHandle('.vscwclang')).getDirectoryHandle('release'); } catch (e) { return null; }
    try { const f = await (await d.getFileHandle('build.log')).getFile(); return { mtime: f.lastModified, text: await f.text() }; } catch (e) { return null; }
  });
  let n = 0;
  const typeAtEnd = async (text) => { await p.mouse.click(700, 400); await p.keyboard.press('Control+End'); await p.keyboard.type(text); await p.keyboard.press('Control+s'); await sleep(300); };
  // Keyboard-only palette pick: a click on the row can time out behind a notification.
  const runCmd = async (name) => {
    await p.keyboard.press('F1'); await sleep(500); await p.keyboard.type(name); await sleep(900);
    const rows = p.locator('.quick-input-list .monaco-list-row'); const cnt = await rows.count();
    for (let i = 0; i < cnt; i++) {
      const label = (await rows.nth(i).locator('.label-name').first().innerText()).trim();
      if (label === name || label.startsWith(name + ' (')) { for (let k = 0; k < i; k++) { await p.keyboard.press('ArrowDown'); } await p.keyboard.press('Enter'); return; }
    }
    throw new Error('no palette row ' + name);
  };
  // On a stalled build: the tail of the vscwclang output channel (copied through the clipboard) shows what the extension was doing.
  const dumpOutput = async () => {
    try {
      await runCmd('Output: Show Output Channels...'); await sleep(800); await p.keyboard.type('vscwclang'); await sleep(600); await p.keyboard.press('Enter'); await sleep(1500);
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
      await runCmd('Output: Focus on Output View'); await sleep(700); await p.keyboard.press('Control+a'); await p.keyboard.press('Control+c'); await sleep(500);
      const text = await p.evaluate(() => navigator.clipboard.readText()); await ctx.clearPermissions();
      const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
      out.push('output tail: ' + (CFG.dumpFilter ? lines.filter(l => new RegExp(CFG.dumpFilter).test(l)).slice(-40) : lines.slice(-12)).join(' | ').slice(-6000));
    } catch (e) { out.push('dumpOutput failed: ' + e.message.slice(0, 120)); }
  };
  const build = async (label, edit) => {
    log('PROGRESS', label + ' start');
    if (edit) { await edit(); }
    log('PROGRESS', label + ' edited');
    await p.keyboard.press('Escape'); await sleep(200);
    await runCmd('vscwClang: Build C++'); const t0 = Date.now();
    while (Date.now() - t0 < CFG.timeoutMs) {
      const l = await readLog();
      if (l && l.mtime >= t0 - 200) {
        const ph = /build phases[^\n]*/.exec(l.text);
        const tm = (l.text.split('--- timings ---')[1] || '').trim().replace(/\/workspace\//g, '').split('\n').join('; ');
        out.push(label + ': ' + ((l.mtime - t0) / 1000).toFixed(2) + ' s' + (tm ? '  {' + tm + '}' : ''));
        return;
      }
      await sleep(50);
    }
    out.push(label + ': TIMEOUT');
    await dumpOutput();
  };
  await ensureOpen(CFG.leaf); await sleep(CFG.settleMs);
  await build('first build (page warm)');
  await build('unchanged');
  for (let i = 0; i < CFG.runs; i++) { await build('edit leaf ' + CFG.leaf, async () => { await openFile(CFG.leaf); await sleep(500); await typeAtEnd(CFG.leafSnippet.replaceAll('N', ++n)); }); }
  for (let i = 0; i < CFG.runs; i++) { await build('edit header ' + CFG.header, async () => { await openFile(CFG.header); await sleep(500); await typeAtEnd('\n// edit ' + (++n) + '\n'); }); }
  if (CFG.dumpAtEnd) { await dumpOutput(); }
  const last = await readLog(); if (last) { out.push('log tail: ' + last.text.slice(-400).replace(/\n/g, ' | ')); }
}
} catch (e) { out.push('ERR ' + e.message.slice(0, 300)); }
return out.join('\n');
