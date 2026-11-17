import * as vscode from 'vscode';
import { getFile, resolveManifest, type DownloadOptions } from '../toolchain/toolchainDownload';
import { VscodeByteStore, type StoreContext } from '../toolchain/toolchainStore';
import { MAKE_PACK_PIN } from './makePin';

const OVERRIDE_SETTING = 'makePackUrl';
const MAKE_WASM = 'make.wasm';

/**
 * Downloads, verifies and caches the optional Make pack (`make.wasm`) on first use.
 *
 * It reuses the toolchain's manifest/chunk/hash machinery but has its own pin (`makePin.ts`) and cache folder
 * (`make-pack/<manifest sha16>/`), and is never prefetched: nothing is downloaded until a Make build asks for it.
 * `vscwclang.makePackUrl` overrides the host and skips the pin (development).
 */
export class MakePack {
	private bytes: Promise<Uint8Array<ArrayBuffer>> | undefined;

	constructor(private readonly context: StoreContext, private readonly log: vscode.OutputChannel) {}

	/** The verified `make.wasm` bytes. */
	getMakeWasm(): Promise<Uint8Array<ArrayBuffer>> {
		this.bytes ??= this.load().catch(e => { this.bytes = undefined; throw e; });
		return this.bytes;
	}

	private async load(): Promise<Uint8Array<ArrayBuffer>> {
		const override = vscode.workspace.getConfiguration('vscwclang').get<string>(OVERRIDE_SETTING, '').trim();
		if (!override && !MAKE_PACK_PIN.manifestSha256) {
			throw new Error('vscwClang: this build of the extension has no published Make pack pinned yet (makePin.ts). Did you mean to set vscwclang.makePackUrl to a locally served pack (see scripts/build-make-wasm.mjs)?');
		}
		const store = new VscodeByteStore(vscode.Uri.joinPath(this.context.globalStorageUri, 'make-pack'));
		const opts: DownloadOptions = { baseUrl: override || MAKE_PACK_PIN.baseUrl, isOffline: () => typeof navigator !== 'undefined' && navigator.onLine === false };
		const { manifest, sha256 } = await resolveManifest(store, opts, override ? undefined : MAKE_PACK_PIN.manifestSha256);
		if (override) { this.log.appendLine(`[vscwclang] make pack override ${opts.baseUrl}: manifest ${sha256.slice(0, 16)} accepted without a pin`); }
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `vscwClang: preparing GNU make ${manifest.tag} (one-time)` },
			() => getFile(manifest, store, sha256.slice(0, 16), MAKE_WASM, opts));
	}

	async clear(): Promise<void> {
		this.bytes = undefined;
		await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.context.globalStorageUri, 'make-pack'), { recursive: true, useTrash: false }).then(undefined, () => undefined);
	}
}
