import * as assert from 'assert';
import { RpcGuestServices } from '../../host/guestWorker';
import type { SyncRpcClient } from '../../host/syncChannel';

/** Parses `Content-Length` framed messages out of `bytes`; throws on any byte that is not part of a well-formed frame. */
function parseFrames(bytes: string): string[] {
	const frames: string[] = [];
	let at = 0;
	while (at < bytes.length) {
		const match = /^Content-Length: (\d+)\r\n\r\n/.exec(bytes.slice(at));
		if (!match) { throw new Error(`Header must provide a Content-Length property at offset ${at}: ${JSON.stringify(bytes.slice(at, at + 60))}`); }
		const start = at + match[0].length;
		frames.push(bytes.slice(start, start + Number(match[1])));
		at = start + Number(match[1]);
	}
	return frames;
}

suite('guest stdout framing across threads', () => {
	// Each thread of a guest has its own RpcGuestServices; clangd writes whole LSP frames to stdout from several of them,
	// one frame at a time, as a header write then a body write that does not end in a newline.
	test('frames written as header then body by alternating threads arrive whole and in write order', () => {
		const received: string[] = [];
		const client = { post: (_op: string, _args: unknown, bytes?: Uint8Array) => { received.push(new TextDecoder().decode(bytes)); }, call: () => ({ value: undefined, bytes: new Uint8Array() }) } as unknown as SyncRpcClient;
		const threadA = new RpcGuestServices(client);
		const threadB = new RpcGuestServices(client);
		const sendFrame = (thread: RpcGuestServices, body: string) => {
			thread.writeOutput(1, new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`));
			thread.writeOutput(1, new TextEncoder().encode(body));
		};

		sendFrame(threadA, '{"id":1}');
		sendFrame(threadB, '{"id":2,"result":null}');
		sendFrame(threadA, '{"id":3}');
		sendFrame(threadB, '{"method":"textDocument/clangd.fileStatus"}');

		assert.deepStrictEqual(parseFrames(received.join('')), ['{"id":1}', '{"id":2,"result":null}', '{"id":3}', '{"method":"textDocument/clangd.fileStatus"}']);
	});
});
