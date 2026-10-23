import * as assert from 'assert';
import { MemoryGuestFs } from '../../host/memoryGuestFs';
import { MountedGuestFs } from '../../host/mountedGuestFs';

suite('MemoryGuestFs and MountedGuestFs', () => {
	const bytes = (s: string) => new TextEncoder().encode(s);

	test('files imply their directories and list them', async () => {
		const fs = new MemoryGuestFs();
		fs.setFile('include/c++/v1/cstdio', bytes('x'));
		fs.setFile('/include/stdio.h', bytes('y'));
		assert.strictEqual((await fs.stat('/include/c++')).type, 'dir');
		assert.strictEqual((await fs.stat('/include/stdio.h')).size, 1);
		const names = (await fs.readDirectory('/include')).map(e => `${e.name}:${e.type}`).sort();
		assert.deepStrictEqual(names, ['c++:dir', 'stdio.h:file']);
		await assert.rejects(fs.stat('/nope'), { code: 'ENOENT' });
		await assert.rejects(fs.readFile('/include'), { code: 'EISDIR' });
	});

	test('read-only by default, writable when asked', async () => {
		const ro = new MemoryGuestFs();
		await assert.rejects(ro.writeFile('/a', bytes('1')), { code: 'EACCES' });
		await assert.rejects(ro.delete('/a'), { code: 'EACCES' });
		const rw = new MemoryGuestFs(true);
		await rw.writeFile('/d/a', bytes('1'));
		await rw.rename('/d/a', '/d/b');
		assert.strictEqual((await rw.readFile('/d/b')).length, 1);
		await assert.rejects(rw.createDirectory('/d'), { code: 'EEXIST' });
	});

	test('mounts: longest match wins, relative paths, synthetic ancestors, cross-mount rename refused', async () => {
		const a = new MemoryGuestFs(true);
		const b = new MemoryGuestFs(true);
		a.setFile('/x.txt', bytes('a'));
		b.setFile('/y.txt', bytes('b'));
		const fs = new MountedGuestFs([{ guestPath: '/home', fs: a }, { guestPath: '/home/user', fs: b }]);
		assert.strictEqual(new TextDecoder().decode(await fs.readFile('/home/x.txt')), 'a');
		assert.strictEqual(new TextDecoder().decode(await fs.readFile('/home/user/y.txt')), 'b');
		assert.deepStrictEqual((await fs.readDirectory('/')).map(e => e.name), ['home']);
		assert.strictEqual((await fs.stat('/home/user')).type, 'dir');
		await assert.rejects(fs.rename('/home/x.txt', '/home/user/x.txt'), { code: 'EACCES' });
		await assert.rejects(fs.readFile('/elsewhere/z'), { code: 'EACCES' });
		await assert.rejects(fs.stat('/elsewhere'), { code: 'ENOENT' });
	});
});
