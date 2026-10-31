import * as assert from 'assert';
import { defaultBuildTask, isCompilerTask, listLaunches, listTasks, planFromTask, programStem, resolveVariables, taskForLaunch, toGuestPath, type VariableContext } from '../../toolchain/projectModel';

const ctx: VariableContext = { folderName: 'proj', file: 'src/app/main.cpp' };

// The C/C++ extension's generated templates.
const linuxTask = {
	type: 'cppbuild', label: 'C/C++: g++ build active file', command: '/usr/bin/g++',
	args: ['-fdiagnostics-color=always', '-g', '${file}', '-o', '${fileDirname}/${fileBasenameNoExtension}'],
	options: { cwd: '${fileDirname}' }, group: { kind: 'build', isDefault: true },
};
const mingwTask = {
	type: 'cppbuild', label: 'C/C++: g++.exe build active file', command: 'C:\\msys64\\ucrt64\\bin\\g++.exe',
	args: ['-fdiagnostics-color=always', '-g', '${file}', '-o', '${fileDirname}\\${fileBasenameNoExtension}.exe'],
	options: { cwd: 'C:\\msys64\\ucrt64\\bin' }, group: 'build',
};

suite('resolveVariables', () => {
	test('file variables resolve to guest paths', () => {
		assert.strictEqual(resolveVariables('${file}', ctx), '/workspace/src/app/main.cpp');
		assert.strictEqual(resolveVariables('${fileDirname}/${fileBasenameNoExtension}${fileExtname}', ctx), '/workspace/src/app/main.cpp');
		assert.strictEqual(resolveVariables('${relativeFile} ${relativeFileDirname} ${fileBasename}', ctx), 'src/app/main.cpp src/app main.cpp');
		assert.strictEqual(resolveVariables('${workspaceFolder}${/}x${pathSeparator}${workspaceFolderBasename}', ctx), '/workspace/x/proj');
	});

	test('a file at the workspace root', () => {
		assert.strictEqual(resolveVariables('${fileDirname}|${relativeFileDirname}', { folderName: 'p', file: 'a.cpp' }), '/workspace|.');
	});

	test('file variables without an active file say so', () => {
		assert.throws(() => resolveVariables('${file}', { folderName: 'p' }), /needs an active C\/C\+\+ file.*open the \.cpp file/);
		assert.strictEqual(resolveVariables('${workspaceFolder}', { folderName: 'p' }), '/workspace');
	});

	test('unsupported variables fail loudly with a suggestion', () => {
		assert.throws(() => resolveVariables('${input:name}', ctx), /unsupported variable '\$\{input:name\}'.*write the value/);
		assert.throws(() => resolveVariables('${command:x}', ctx), /unsupported variable/);
		assert.throws(() => resolveVariables('${env:HOME}', ctx), /unsupported variable/);
		assert.throws(() => resolveVariables('${bogus}', ctx), /Did you mean one of/);
	});
});

suite('toGuestPath', () => {
	test('normalizes, accepts both slash styles', () => {
		assert.strictEqual(toGuestPath('a\\b/../c.cpp', '/workspace/src'), '/workspace/src/a/c.cpp');
		assert.strictEqual(toGuestPath('./x.cpp', '/workspace'), '/workspace/x.cpp');
		assert.strictEqual(toGuestPath('/workspace/x.cpp', '/workspace/src'), '/workspace/x.cpp');
	});

	test('host paths and escapes are rejected', () => {
		assert.throws(() => toGuestPath('C:\\msys64\\x.cpp', '/workspace'), /outside the workspace folder.*Did you mean/);
		assert.throws(() => toGuestPath('/usr/include/x.cpp', '/workspace'), /outside the workspace/);
		assert.throws(() => toGuestPath('../../x.cpp', '/workspace'), /outside the workspace/);
	});
});

suite('planFromTask', () => {
	test('Linux g++ template', () => {
		const plan = planFromTask(linuxTask, ctx);
		assert.deepStrictEqual(plan.sources, ['src/app/main.cpp']);
		assert.deepStrictEqual(plan.flags, ['-g']);
		assert.strictEqual(plan.outputName, 'main.wasm');
		assert.strictEqual(plan.mode, 'debug');
		assert.ok(plan.notes.some(n => n.includes('-fdiagnostics-color=always')));
	});

	test('MinGW template: backslashes, .exe, host cwd is rejected only if used', () => {
		// The template's cwd is a host path; it is outside the workspace, so the task cannot be mapped faithfully.
		assert.throws(() => planFromTask(mingwTask, ctx), /outside the workspace folder/);
		const plan = planFromTask({ ...mingwTask, options: { cwd: '${fileDirname}' } }, ctx);
		assert.deepStrictEqual(plan.sources, ['src/app/main.cpp']);
		assert.strictEqual(plan.outputName, 'main.wasm');
	});

	test('clang++ with includes, defines, standard and link flags', () => {
		const plan = planFromTask({
			label: 'b', command: 'clang++',
			args: ['-std=c++20', '-O2', '-Iinclude', '-I', '${workspaceFolder}/third', '-isystem', 'vendor', '-DNAME=1', '-D', 'X', '-lm', '-L', 'libs', '${workspaceFolder}/src/a.cpp', 'src/b.cc', '-o', 'bin/prog'],
		}, ctx);
		assert.deepStrictEqual(plan.sources, ['src/a.cpp', 'src/b.cc']);
		assert.deepStrictEqual(plan.flags, ['-std=c++20', '-O2', '-I/workspace/include', '-I/workspace/third', '-isystem/workspace/vendor', '-DNAME=1', '-D', 'X', '-lm', '-L/workspace/libs']);
		assert.strictEqual(plan.outputName, 'prog.wasm');
		assert.strictEqual(plan.mode, 'release');
	});

	test('relative paths resolve against options.cwd', () => {
		const plan = planFromTask({ command: 'g++', args: ['main.cpp', '-Iinc'], options: { cwd: '${workspaceFolder}/sub' } }, ctx);
		assert.deepStrictEqual(plan.sources, ['sub/main.cpp']);
		assert.deepStrictEqual(plan.flags, ['-I/workspace/sub/inc']);
	});

	test('globs become workspace-relative globs, including cpptools **.cpp', () => {
		assert.deepStrictEqual(planFromTask({ command: 'g++', args: ['${fileDirname}/*.cpp', '${workspaceFolder}/**.cpp'] }, ctx).sources, ['src/app/*.cpp', '**/*.cpp']);
	});

	test('no -o leaves the default output', () => {
		assert.strictEqual(planFromTask({ command: 'gcc', args: ['x.c'] }, ctx).outputName, undefined);
	});

	test('versioned and prefixed compiler names are recognized', () => {
		for (const command of ['g++-13', 'clang-18', 'x86_64-w64-mingw32-g++.exe', 'C:\\llvm\\bin\\clang++.exe', 'c++', 'cc']) {
			assert.deepStrictEqual(planFromTask({ command, args: ['x.cpp'] }, ctx).sources, ['x.cpp'], command);
		}
	});

	test('unsandboxable flags are dropped with a note', () => {
		const plan = planFromTask({ command: 'g++', args: ['-pthread', '-static', '-lstdc++', '-m64', '-mwindows', 'x.cpp'] }, ctx);
		assert.deepStrictEqual(plan.flags, []);
		assert.strictEqual(plan.notes.length, 5);
	});

	test('forbidden flags are rejected with did-you-mean', () => {
		assert.throws(() => planFromTask({ label: 'L', command: 'g++', args: ['-c', 'x.cpp'] }, ctx), /task 'L'.*'-c' is not allowed.*Did you mean/);
		assert.throws(() => planFromTask({ command: 'g++', args: ['-I/usr/include/foo', 'x.cpp'] }, ctx), /outside the workspace/);
		assert.throws(() => planFromTask({ command: 'g++', args: ['--target=x86_64', 'x.cpp'] }, ctx), /not allowed/);
	});

	test('other programs are rejected with a suggestion', () => {
		assert.throws(() => planFromTask({ command: 'cl.exe', args: ['/EHsc', 'x.cpp'] }, ctx), /MSVC.*Did you mean g\+\+ or clang\+\+/);
		assert.throws(() => planFromTask({ command: 'make' }, ctx), /cannot run make, cmake|not a compiler driver.*compile_commands\.json/);
	});

	test('a whole command line in "command" is split', () => {
		const plan = planFromTask({ type: 'shell', label: 's', command: 'g++ -std=c++17 "src/my main.cpp" -o out/app.exe' }, ctx);
		assert.deepStrictEqual(plan.sources, ['src/my main.cpp']);
		assert.deepStrictEqual(plan.flags, ['-std=c++17']);
		assert.strictEqual(plan.outputName, 'app.wasm');
	});

	test('object files, libraries and missing sources are rejected', () => {
		assert.throws(() => planFromTask({ command: 'g++', args: ['x.cpp', 'util.o'] }, ctx), /cannot use 'util\.o'/);
		assert.throws(() => planFromTask({ command: 'g++', args: ['-O2'] }, ctx), /names no source file.*\$\{file\}/);
		assert.throws(() => planFromTask({ command: 'g++', args: ['x.cpp', '-o'] }, ctx), /'-o' has no file name/);
		assert.throws(() => planFromTask({ command: 'g++', args: ['/home/me/x.cpp'] }, ctx), /outside the workspace/);
	});

	test('args given as objects with a value are read', () => {
		assert.deepStrictEqual(planFromTask({ command: 'g++', args: [{ value: 'x.cpp', quoting: 'strong' }] }, ctx).sources, ['x.cpp']);
	});
});

suite('launch.json and task selection', () => {
	const tasks = listTasks([
		{ label: 'make', type: 'shell', command: 'make' },
		linuxTask,
		{ label: 'other', command: 'g++', args: ['o.cpp', '-o', 'other.exe'] },
		{ type: 'vscwclang', label: 'no command' },
	]);

	test('listTasks keeps command tasks and finds the default build', () => {
		assert.deepStrictEqual(tasks.map(t => t.label), ['make', 'C/C++: g++ build active file', 'other']);
		assert.strictEqual(defaultBuildTask(tasks)?.label, 'C/C++: g++ build active file');
		assert.strictEqual(defaultBuildTask(listTasks([mingwTask])), undefined, 'a non-default build group is not the default');
	});

	test('listLaunches reads args, string args, and skips attach and unknown types', () => {
		const launches = listLaunches([
			{ name: 'a', type: 'cppdbg', request: 'launch', program: '${fileDirname}/${fileBasenameNoExtension}', args: ['one', '${fileBasename}', 2], preLaunchTask: 'other' },
			{ name: 'b', type: 'lldb', request: 'launch', program: '${command:pick}', args: "x 'y z'" },
			{ name: 'c', type: 'cppdbg', request: 'attach' },
			{ name: 'd', type: 'node', request: 'launch' },
			{ name: 'e', type: 'cppdbg', request: 'launch', program: 'p' },
		], ctx);
		assert.deepStrictEqual(launches, [
			{ name: 'a', program: '/workspace/src/app/main', args: ['one', 'main.cpp', '2'], preLaunchTask: 'other' },
			{ name: 'b', program: undefined, args: ['x', 'y z'], preLaunchTask: undefined },
			{ name: 'e', program: 'p', args: undefined, preLaunchTask: undefined },
		]);
	});

	test('an unresolvable variable in args names the configuration', () => {
		assert.throws(() => listLaunches([{ name: 'cfg', type: 'cppdbg', request: 'launch', args: ['${input:a}'] }], ctx), /unsupported variable.*launch configuration 'cfg'/);
	});

	test('taskForLaunch: preLaunchTask, then -o matching program, then the default build', () => {
		assert.strictEqual(taskForLaunch(tasks, { name: 'x', args: [], preLaunchTask: 'other' }, ctx)?.label, 'other');
		assert.strictEqual(taskForLaunch(tasks, { name: 'x', args: [], program: 'C:/anywhere/other.exe' }, ctx)?.label, 'other');
		assert.strictEqual(taskForLaunch(tasks, { name: 'x', args: [], program: 'nomatch' }, ctx)?.label, 'C/C++: g++ build active file');
		assert.strictEqual(taskForLaunch(tasks, undefined, ctx)?.label, 'C/C++: g++ build active file');
		assert.strictEqual(taskForLaunch(listTasks([{ label: 'z', command: 'g++', args: ['z.cpp'] }]), undefined, ctx), undefined);
	});

	test('isCompilerTask looks at the first word only', () => {
		assert.ok(isCompilerTask({ command: 'g++ -O2 x.cpp' }));
		assert.ok(isCompilerTask({ command: '"C:/Program Files/LLVM/bin/clang++.exe" x.cpp' }));
		assert.ok(!isCompilerTask({ command: 'make -j4' }));
		assert.ok(!isCompilerTask({ command: '${config:compiler}' }));
		assert.ok(!isCompilerTask({}));
	});

	test('programStem agrees across desktop and wasm names', () => {
		assert.strictEqual(programStem('C:\\a\\prog.exe'), 'prog');
		assert.strictEqual(programStem('.vscwclang/debug/prog.wasm'), 'prog');
		assert.strictEqual(programStem('a.out'), 'a.out');
	});
});
