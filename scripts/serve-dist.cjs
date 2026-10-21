// Serves a toolchain dist folder (llvm-artifacts/dist) with the CORS and CORP headers vscode.dev's COEP needs, and logs
// each requested path. Set vscwclang.toolchainUrl to http://localhost:5001 to test local binaries before publishing.
//
//   node scripts/serve-dist.cjs llvm-artifacts/dist [--slow]    # --slow: ~2.5 MB/s, to catch the download Cancel button
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(process.argv[2] || 'llvm-artifacts/dist');
const slow = process.argv.includes('--slow');
http.createServer((q, r) => {
  console.log(q.url);
  const headers = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'no-store' };
  fs.readFile(path.join(root, decodeURIComponent(q.url.split('?')[0])), async (e, d) => {
    if (e) { r.writeHead(404, headers); r.end(); return; }
    r.writeHead(200, { ...headers, 'Content-Length': d.length });
    for (let i = 0; i < d.length; i += 262144) {
      if (!r.write(d.subarray(i, i + 262144))) { await new Promise(x => r.once('drain', x)); }
      if (slow && d.length > 1e6) { await new Promise(x => setTimeout(x, 100)); }
    }
    r.end();
  });
}).listen(5001, () => console.log('serving ' + root + ' on http://localhost:5001'));
