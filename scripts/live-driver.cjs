// Drives a Chrome that is already running with --remote-debugging-port=9333 on vscode.dev (see
// documents/live_testing.md for the whole setup). Start it, then POST an async function body to
// http://127.0.0.1:9444/run; the body sees {p, ctx, sleep, step, shot, cmd, palette, seed, log}.
//
//   node scripts/live-driver.cjs            # outputs (console.log, screenshots) go to $VSCW_LIVE_DIR
//   curl -s --data-binary @test.js http://127.0.0.1:9444/run
//
// `seed({'main.cpp': '...'})` replaces an OPFS folder, reloads vscode.dev and opens it through a patched
// showDirectoryPicker, so no folder-picker click is needed. console.log gets every console warning/error, page
// error, failed request and HTTP >= 400, tagged with the current `step(name)`.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const OUT = process.env.VSCW_LIVE_DIR || path.join(os.tmpdir(), 'vscwclang-live');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'console.log');
let current = 'init';
const log = (kind, msg) => fs.appendFileSync(LOG, `[${new Date().toISOString().slice(11, 19)}] [${current}] ${kind}: ${String(msg).slice(0, 600).replace(/\n/g, ' | ')}\n`);
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333');
  const ctx = b.contexts()[0];
  const p = ctx.pages()[0];
  await ctx.addInitScript(() => {
    if (location.hostname !== 'vscode.dev') { return; }
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('proj', { create: true });
  });
  const hook = (pg) => {
    pg.on('console', m => { const t = m.type(); if (t === 'warning' || t === 'error') { log('console.' + t, m.text() + ' @' + (m.location().url || '').slice(-60)); } });
    pg.on('pageerror', e => log('pageerror', e.message));
    pg.on('requestfailed', r => log('requestfailed', r.url().slice(0, 150) + ' ' + (r.failure() || {}).errorText));
    pg.on('response', r => { if (r.status() >= 400 && !/\.map$/.test(r.url())) { log('http' + r.status(), r.url().slice(0, 150)); } });
  };
  hook(p);
  ctx.on('page', hook);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const api = {
    p, ctx, sleep, log,
    step: n => { current = n; log('STEP', n); },
    shot: n => p.screenshot({ path: path.join(OUT, n + '.png') }),
    // Runs the palette command whose label is exactly `name` (fuzzy ranking can put another command first).
    cmd: async (name) => {
      await p.keyboard.press('F1'); await sleep(500); await p.keyboard.type(name); await sleep(900);
      const rows = p.locator('.quick-input-list .monaco-list-row');
      const n = await rows.count();
      const labels = [];
      for (let i = 0; i < n; i++) {
        const label = (await rows.nth(i).locator('.label-name').first().innerText()).trim();
        labels.push(label);
        if (label === name || label.startsWith(name + ' (')) { await rows.nth(i).click(); return label; }
      }
      await p.keyboard.press('Escape');
      throw new Error('no exact palette row for ' + name + '; saw ' + JSON.stringify(labels));
    },
    palette: async (t, enter = true) => { await p.keyboard.press('F1'); await sleep(500); await p.keyboard.type(t); await sleep(800); if (enter) { await p.keyboard.press('Enter'); } },
    seed: async (files) => {
      await p.evaluate(async (files) => {
        const root = await navigator.storage.getDirectory();
        try { await root.removeEntry('proj', { recursive: true }); } catch (e) { /* first run */ }
        const dir = await root.getDirectoryHandle('proj', { create: true });
        for (const [file, text] of Object.entries(files)) {
          let d = dir; const parts = file.split('/');
          for (const s of parts.slice(0, -1)) { d = await d.getDirectoryHandle(s, { create: true }); }
          const f = await d.getFileHandle(parts.at(-1), { create: true });
          const w = await f.createWritable(); await w.write(text); await w.close();
        }
      }, files);
      await p.goto('https://vscode.dev/'); await sleep(6000);
      await p.getByRole('button', { name: 'Open Folder' }).first().click(); await sleep(5000);
    },
  };
  http.createServer((q, r) => {
    let body = '';
    q.on('data', d => { body += d; });
    q.on('end', async () => {
      try {
        const fn = new Function('api', `return (async()=>{ const {p,ctx,sleep,step,shot,palette,cmd,seed,log}=api; ${body} })()`);
        const out = await fn(api);
        r.end(JSON.stringify(out === undefined ? 'ok' : out));
      } catch (e) { log('DRIVER-ERROR', e.message); r.end('ERROR: ' + e.message); }
    });
  }).listen(9444, () => console.log('driver up; output in ' + OUT));
})();
