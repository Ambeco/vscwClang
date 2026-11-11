// Flow 2 timing for live-driver.cjs (documents/perf_baseline.md "Browser flows"): Build and Run, then edit lib.cpp and Build and Run again, timed until the program writes result.txt.
// Run: curl -s --data-binary @scripts/live-flow-edit.js http://127.0.0.1:9444/run
const out = [];
try {
await seed({
 'lib.h': '#pragma once\n#include <string>\n#include <vector>\nint version();\nstd::string describe(const std::vector<int>& v);\n',
 'lib.cpp': '#include "lib.h"\n#include <sstream>\nint version() { return 1; }\nstd::string describe(const std::vector<int>& v) {\n  std::ostringstream os;\n  for (int x : v) os << x << ",";\n  return os.str();\n}\n',
 'other.cpp': '#include <map>\n#include <string>\nint other() { std::map<std::string, int> m{{"a", 1}}; return m["a"]; }\n',
 'main.cpp': '#include "lib.h"\n#include <fstream>\n#include <iostream>\n#include <cassert>\n#include <chrono>\nint main() {\n  std::vector<int> v{1, 2, 3};\n  assert(describe(v) == "1,2,3,");\n  auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();\n  std::ofstream("result.txt") << "PASS " << version() << " " << ms << "\\n";\n  std::cout << "PASS" << std::endl;\n  return 0;\n}\n',
});
await p.keyboard.press('Control+p'); await sleep(300); await p.keyboard.type('lib.cpp'); await sleep(500); await p.keyboard.press('Enter');
await sleep(25000);
const readResult = () => p.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('proj'); try { return await (await (await d.getFileHandle('result.txt')).getFile()).text(); } catch (e) { return ''; } });
const runCmd = async (name) => {
  await p.keyboard.press('Escape'); await sleep(200);
  await p.keyboard.press('F1'); await sleep(500); await p.keyboard.type(name); await sleep(900);
  const rows = p.locator('.quick-input-list .monaco-list-row');
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const label = (await rows.nth(i).locator('.label-name').first().innerText()).trim();
    if (label === name || label.startsWith(name + ' (')) { for (let k = 0; k < i; k++) { await p.keyboard.press('ArrowDown'); } await p.keyboard.press('Enter'); return; }
  }
  throw new Error('no row ' + name);
};
const runOnce = async (label, edit) => {
  if (edit) { await edit(); await p.keyboard.press('Control+s'); await sleep(300); }
  await runCmd('vscwClang: Build and Run C++');
  const t0 = Date.now(); let r = '';
  while (Date.now() - t0 < 120000) {
    r = await readResult();
    const m = /^PASS (\d+) (\d+)\n$/.exec(r);
    if (m && Number(m[2]) >= t0 - 1000) { out.push(label + ': ' + ((Date.now() - t0) / 1000).toFixed(2) + 's (program wrote result ' + (Number(m[2]) - t0) + ' ms after click)'); return; }
    await sleep(50);
  }
  out.push(label + ': TIMEOUT ' + JSON.stringify(r));
};
const typeAtEnd = async (text) => { await p.mouse.click(700, 400); await p.keyboard.press('Control+End'); await p.keyboard.type(text); };
let n = 0;
await runOnce('first build+run (page warm)');
await runOnce('rerun unchanged');
await runOnce('edit lib.cpp, run', () => typeAtEnd('\nint extra' + (++n) + '() { return ' + n + '; }\n'));
await runOnce('edit lib.cpp, run', () => typeAtEnd('\nint extra' + (++n) + '() { return ' + n + '; }\n'));
await runOnce('edit lib.cpp, run', () => typeAtEnd('\nint extra' + (++n) + '() { return ' + n + '; }\n'));
} catch (e) { out.push('ERR ' + e.message.slice(0, 300)); }
return out.join('\n');
