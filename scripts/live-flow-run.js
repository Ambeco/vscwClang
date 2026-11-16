// Run startup and Debug launch/step latency in the real browser (documents/perf_baseline.md "Run and debug latency").
// Prefix scripts/flow-configs/run.js (const CFG) and post to live-driver.cjs; scripts/live-flow-run.sh does it.
// The program writes its own CLOCK_REALTIME ms to /workspace/t_start.txt as its first action, so
//   click->start  = Run command Enter to program main,
//   startup       = end of the build (build.log mtime) to program main,
// both in one clock domain (Date.now() and the OS file times). Debug uses stopOnEntry: F5 to the first stop, then step-over latency.
const out = [];
try {
  const med = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const f1 = n => (n / 1000).toFixed(2) + ' s';
  const opfs = (fn, arg) => p.evaluate(fn, arg);
  const readStart = () => opfs(async () => {
    try { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('proj'); const t = await (await (await d.getFileHandle('t_start.txt')).getFile()).text(); return t ? +t : null; } catch (e) { return null; }
  });
  const rmStart = () => opfs(async () => { try { await (await (await navigator.storage.getDirectory()).getDirectoryHandle('proj')).removeEntry('t_start.txt'); } catch (e) { /* none */ } });
  const logMtime = mode => opfs(async m => {
    try { const d = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('proj')).getDirectoryHandle('.vscwclang')).getDirectoryHandle(m); return (await (await d.getFileHandle('build.log')).getFile()).lastModified; } catch (e) { return null; }
  }, mode);
  const runCmd = async (name) => {
    await p.keyboard.press('F1'); await sleep(500); await p.keyboard.type(name); await sleep(900);
    const rows = p.locator('.quick-input-list .monaco-list-row'); const cnt = await rows.count();
    for (let i = 0; i < cnt; i++) {
      const label = (await rows.nth(i).locator('.label-name').first().innerText()).trim();
      if (label === name || label.startsWith(name + ' (')) { for (let k = 0; k < i; k++) { await p.keyboard.press('ArrowDown'); } await p.keyboard.press('Enter'); return; }
    }
    throw new Error('no palette row ' + name);
  };
  const openFile = async (name) => { await p.keyboard.press('Escape'); await sleep(200); await p.keyboard.press('Control+p'); await sleep(300); await p.keyboard.type(name); await sleep(600); await p.keyboard.press('Enter'); await sleep(1500); };
  const stopped = () => p.evaluate(() => !!document.querySelector('.debug-top-stack-frame-line, .debug-top-stack-frame'));
  const topLine = () => p.evaluate(() => { const e = document.querySelector('.debug-top-stack-frame-line'); return e ? Math.round(e.getBoundingClientRect().top) : null; });
  // The toolbar element stays in the DOM (hidden) after a session ends, so test visibility.
  const toolbar = () => p.evaluate(() => { const e = document.querySelector('.debug-toolbar'); return !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== 'none'; });
  const waitFor = async (fn, ms) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) { return Date.now() - t0; } if (Date.now() - t0 > ms) { return null; } await sleep(25); } };

  for (const v of CFG.variants) {
    out.push('== ' + v.name);
    await seed({
      [v.file]: v.text,
      '.vscode/launch.json': JSON.stringify({ version: '0.2.0', configurations: [{ type: 'vscwclang', request: 'launch', name: 'Debug C++ (vscwClang)', program: '.vscwclang/debug/a.out.wasm', stopOnEntry: true, console: 'internalConsole' }] }),
    });
    await sleep(12000);
    await runCmd('View: Close All Editors'); await sleep(500);
    await openFile(v.file); await sleep(CFG.settleMs || 8000);
    const clickToStart = [], startup = [];
    for (let i = 0; i < CFG.runs; i++) {
      await rmStart(); await p.keyboard.press('Escape');
      await runCmd('vscwClang: Build and Run C++'); const t0 = Date.now();
      let start = null; const w = await waitFor(async () => { start = await readStart(); return start; }, CFG.timeoutMs);
      if (w === null) { out.push('run ' + i + ': TIMEOUT'); continue; }
      const built = await logMtime('release');
      clickToStart.push(start - t0); startup.push(start - built);
      out.push(`run ${i}${i === 0 ? ' (first, cold)' : ''}: click->start ${f1(start - t0)}, build end->start ${f1(start - built)}`);
      await sleep(1500);
    }
    out.push(`Run median (warm, runs 1+): click->start ${f1(med(clickToStart.slice(1)))}, build end->start ${f1(med(startup.slice(1)))}`);

    const launchStops = [], buildToStop = [], stepMs = [];
    for (let i = 0; i < CFG.debugRuns; i++) {
      await rmStart();
      await p.mouse.click(700, 300); await sleep(300);
      await p.keyboard.press('F5'); const t0 = Date.now();
      const w = await waitFor(stopped, CFG.timeoutMs);
      if (w === null) { out.push('debug ' + i + ': TIMEOUT waiting for the stop'); await shot('debug-timeout-' + i); break; }
      const stopAt = Date.now(); const built = await logMtime('debug');
      launchStops.push(stopAt - t0); buildToStop.push(stopAt - built);
      out.push(`debug ${i}${i === 0 ? ' (first, cold)' : ''}: F5->stopped ${f1(stopAt - t0)}, debug build end->stopped ${f1(stopAt - built)}`);
      for (let s = 0; s < CFG.steps; s++) {
        const before = await topLine(); const ts = Date.now();
        await p.locator('.debug-toolbar .codicon-debug-step-over').first().click();
        const moved = await waitFor(async () => { const t = await topLine(); return t !== null && t !== before; }, 15000);
        if (moved === null) { out.push('  step ' + s + ': no movement in 15 s'); break; }
        stepMs.push(Date.now() - ts); out.push('  step ' + s + ': ' + (Date.now() - ts) + ' ms');
      }
      await p.locator('.debug-toolbar .codicon-debug-continue').first().click().catch(() => undefined);
      const ended = await waitFor(async () => !(await toolbar()), 30000);
      out.push('  continue->session end: ' + (ended === null ? 'TIMEOUT' : ended + ' ms'));
      if (ended === null) { await p.keyboard.press('Shift+F5'); await sleep(2000); }
      await sleep(1500);
    }
    out.push(`Debug median (warm, runs 1+): F5->stopped ${f1(med(launchStops.slice(1)))}, debug build end->stopped ${f1(med(buildToStop.slice(1)))}; step-over median ${med(stepMs)} ms`);
  }
} catch (e) { out.push('ERR ' + e.message.slice(0, 300)); }
return out.join('\n');
