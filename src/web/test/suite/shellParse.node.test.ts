import * as assert from 'assert';
import { parseShellLine, ShellSyntaxError } from '../../buildgraph/shellParse';

const words = (line: string) => parseShellLine(line).map(i => i.command.argv.map(w => w.text));

suite('parseShellLine', () => {
	test('splits words and honours quotes and escapes', () => {
		assert.deepStrictEqual(words(`cc -DNAME="a b" -I'x y' z\\ w`), [['cc', '-DNAME=a b', '-Ix y', 'z w']]);
		assert.deepStrictEqual(words(`echo "say \\"hi\\" \\\\ \\$ \\\`"`), [['echo', 'say "hi" \\ $ `']]);
		assert.deepStrictEqual(words(`echo 'a\\b' ''`), [['echo', 'a\\b', '']]);
	});

	test('joins commands with &&, || and ;', () => {
		const items = parseShellLine('a && b || c ; d');
		assert.deepStrictEqual(items.map(i => [i.command.argv[0].text, i.joinedBy]), [['a', undefined], ['b', '&&'], ['c', '||'], ['d', ';']]);
	});

	test('a trailing semicolon and surrounding blanks are fine, an empty or comment-only line has no commands', () => {
		assert.strictEqual(parseShellLine('  a ;  ').length, 1);
		assert.deepStrictEqual(parseShellLine(''), []);
		assert.deepStrictEqual(parseShellLine('   # nothing here'), []);
		assert.deepStrictEqual(words('cc -c a.c # compile'), [['cc', '-c', 'a.c']]);
	});

	test('a # inside a word is not a comment', () => {
		assert.deepStrictEqual(words('echo a#b "#c"'), [['echo', 'a#b', '#c']]);
	});

	test('newlines separate commands, a backslash-newline continues one', () => {
		assert.deepStrictEqual(words('a b\nc d'), [['a', 'b'], ['c', 'd']]);
		assert.deepStrictEqual(words('cc -c \\\n  a.c'), [['cc', '-c', 'a.c']]);
	});

	test('leading VAR=value assignments belong to the command', () => {
		const [item] = parseShellLine('CC=gcc FLAGS="-O2 -g" cc -c a.c');
		assert.deepStrictEqual(item.command.assignments, { CC: 'gcc', FLAGS: '-O2 -g' });
		assert.deepStrictEqual(item.command.argv.map(w => w.text), ['cc', '-c', 'a.c']);
		assert.deepStrictEqual(words('echo A=b'), [['echo', 'A=b']]);
	});

	test('redirections: >, >>, 2>, 2>&1, /dev/null, with and without a space', () => {
		const [a] = parseShellLine('echo hi > out.txt');
		assert.deepStrictEqual(a.command.redirects, [{ fd: 1, op: '>', target: 'out.txt' }]);
		const [b] = parseShellLine('echo hi>>log 2>&1');
		assert.deepStrictEqual(b.command.redirects, [{ fd: 1, op: '>>', target: 'log' }, { fd: 2, op: '>', dupOf: 1 }]);
		const [c] = parseShellLine('cc x.c 2>/dev/null');
		assert.deepStrictEqual(c.command.redirects, [{ fd: 2, op: '>', target: '/dev/null' }]);
		const [d] = parseShellLine('echo a2>file');
		assert.deepStrictEqual(d.command.argv.map(w => w.text), ['echo', 'a2']);
		const [e] = parseShellLine("echo 2 > file");
		assert.deepStrictEqual(e.command.argv.map(w => w.text), ['echo', '2']);
	});

	test('unquoted glob characters flag the word, quoted ones do not', () => {
		const [item] = parseShellLine(`rm -f *.o "*.a" lib?.a`);
		assert.deepStrictEqual(item.command.argv.map(w => [w.text, w.glob]), [['rm', false], ['-f', false], ['*.o', true], ['*.a', false], ['lib?.a', true]]);
	});

	suite('rejects what it cannot read', () => {
		const rejected: [string, RegExp][] = [
			['cat a | wc -l', /pipelines/],
			['sleep 1 &', /background/],
			['cat < in', /input redirection/],
			['cat <<EOF', /here-documents/],
			['(cd a && make)', /subshells/],
			['if true; then echo a; fi', /control syntax `if`/],
			['for f in a b; do echo $f; done', /control syntax `for`/],
			['while true; do :; done', /control syntax `while`/],
			['case x in x) ;; esac', /control syntax `case`/],
			['echo $HOME', /shell variables/],
			['echo "$HOME"', /shell variables/],
			['echo $(date)', /substitution/],
			['echo ${X:-a}', /parameter expansion/],
			['echo $((1+2))', /substitution/],
			['echo `date`', /backtick/],
			['echo "`date`"', /backtick/],
			["echo 'abc", /unterminated single quote/],
			['echo "abc', /unterminated double quote/],
			['X=1', /bare variable assignment/],
			['> file', /redirection with no command/],
			['echo a >', /no file name/],
			['echo a &>b', /background|unsupported/],
			['echo a 3>&1', /unsupported|background/],
			['a &&', /no command after/],
			['&& a', /no command before/],
		];
		for (const [line, pattern] of rejected) {
			test(JSON.stringify(line), () => {
				assert.throws(() => parseShellLine(line), (e: unknown) => e instanceof ShellSyntaxError && pattern.test(e.message) && /Did you mean/.test(e.message) && e.message.includes('vscwClang'), `${line} should be rejected`);
			});
		}
	});

	test('a quoted keyword or a keyword after the command word is an ordinary word', () => {
		assert.deepStrictEqual(words(`"if" a`), [['if', 'a']]);
		assert.deepStrictEqual(words('echo if for do'), [['echo', 'if', 'for', 'do']]);
	});

	test('a dollar inside single quotes is literal', () => {
		assert.deepStrictEqual(words(`echo '$HOME $(x)'`), [['echo', '$HOME $(x)']]);
	});
});
