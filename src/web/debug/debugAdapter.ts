import * as vscode from 'vscode';
import { build } from '../toolchain/toolchain';

interface DapMessage { seq: number; type: string; command?: string; arguments?: any; }

/**
 * Inline Debug Adapter: lives in the extension host (web extensions have no child processes).
 * Template only: handles the DAP handshake, then fails the launch loudly. Real stepping/breakpoints/
 * variables are milestones 4-6 in documents/remaining_work.md.
 */
export class VscwClangDebugAdapter implements vscode.DebugAdapter {
	private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	readonly onDidSendMessage = this.emitter.event;
	private seq = 1;

	constructor(private readonly session: vscode.DebugSession, private readonly log: vscode.OutputChannel, private readonly context: vscode.ExtensionContext) {}

	handleMessage(message: vscode.DebugProtocolMessage): void {
		const m = message as DapMessage;
		if (m.type !== 'request') { return; }
		void this.handleRequest(m).catch(err => this.respond(m, false, { message: String(err?.message ?? err) }));
	}

	private async handleRequest(req: DapMessage): Promise<void> {
		switch (req.command) {
			case 'initialize':
				this.respond(req, true, { supportsConfigurationDoneRequest: true });
				this.send({ type: 'event', event: 'initialized' });
				return;
			case 'launch': {
				const folder = this.session.workspaceFolder?.uri;
				if (!folder) { throw new Error('vscwClang: open a workspace folder before debugging.'); }
				const program = vscode.Uri.joinPath(folder, req.arguments?.program ?? '.vscwclang/debug/a.out.wasm');
				const result = await build({ sources: [], output: program, flags: [], mode: 'debug' }, this.log, this.context);
				throw new Error(`Build finished (exit ${result.exitCode}) but running/debugging is not implemented yet. See documents/remaining_work.md.`);
			}
			case 'configurationDone':
			case 'setBreakpoints':
			case 'setExceptionBreakpoints':
				this.respond(req, true, { breakpoints: [] });
				return;
			case 'threads':
				this.respond(req, true, { threads: [] });
				return;
			case 'disconnect':
			case 'terminate':
				this.respond(req, true, {});
				return;
			default:
				throw new Error(`vscwClang debug adapter: DAP request '${req.command}' is not implemented yet. Did you mean to implement it in src/web/debug/debugAdapter.ts?`);
		}
	}

	private respond(req: DapMessage, success: boolean, body: object): void {
		this.send(success
			? { type: 'response', request_seq: req.seq, command: req.command, success, body }
			: { type: 'response', request_seq: req.seq, command: req.command, success, ...body });
	}

	private send(msg: object): void {
		this.emitter.fire({ seq: this.seq++, ...msg } as vscode.DebugProtocolMessage);
	}

	dispose(): void { this.emitter.dispose(); }
}
