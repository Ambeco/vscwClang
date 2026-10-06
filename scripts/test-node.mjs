// Runs the vscode-free tests (*.node.test.ts) in plain node; the rest run under test-web via `npm test`.
import { build } from 'esbuild';
import { globSync } from 'glob';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entries = globSync('src/web/test/suite/*.node.test.ts', { posix: true });
const outdir = mkdtempSync(join(tmpdir(), 'vscwclang-node-tests-'));
await build({ entryPoints: entries, bundle: true, platform: 'node', outdir, logLevel: 'warning' });
const files = entries.map(e => join(outdir, e.split('/').pop().replace(/\.ts$/, '.js')));
const r = spawnSync(process.execPath, ['node_modules/mocha/bin/mocha.js', '--ui', 'tdd', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
