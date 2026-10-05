import * as vscode from 'vscode';

interface ChunkManifest {
	name: string;
	totalBytes: number;
	sha256: string;
	chunks: string[];
}

/**
 * Reads a file stored as several chunks (see scripts/split-wasm.mjs) back into one buffer.
 *
 * Extensions are the only viable place to load large binaries from on vscode.dev (CORS/COEP), and Marketplace
 * size caps are undocumented, so large files are shipped as chunks. The manifest's size and SHA-256 are checked.
 */
export async function readChunked(dir: vscode.Uri, name: string): Promise<Uint8Array<ArrayBuffer>> {
	const manifestBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, `${name}.chunks.json`));
	const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ChunkManifest;
	const parts = await Promise.all(manifest.chunks.map(c => vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, c))));
	const out = new Uint8Array(manifest.totalBytes);
	let offset = 0;
	for (const [i, part] of parts.entries()) {
		if (offset + part.byteLength > out.byteLength) {
			throw new Error(`${name}: chunk ${manifest.chunks[i]} overruns the manifest's totalBytes (${manifest.totalBytes}); was it re-split without updating the manifest?`);
		}
		out.set(part, offset);
		offset += part.byteLength;
	}
	if (offset !== manifest.totalBytes) {
		throw new Error(`${name}: chunks total ${offset} bytes, manifest says ${manifest.totalBytes}; a chunk file is missing or truncated.`);
	}
	const digest = await crypto.subtle.digest('SHA-256', out);
	const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
	if (hex !== manifest.sha256) {
		throw new Error(`${name}: SHA-256 mismatch (got ${hex}, manifest ${manifest.sha256}).`);
	}
	return out;
}
