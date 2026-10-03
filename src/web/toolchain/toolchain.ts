import * as vscode from 'vscode';

export interface BuildRequest {
	/** Workspace-relative or absolute source files to compile. */
	sources: vscode.Uri[];
	/** Where the linked .wasm goes. */
	output: vscode.Uri;
	/** Extra user flags; restricted ones are rejected by the toolchain (see documents/design.md). */
	flags: string[];
	/** "debug" adds -O0 -g, hook instrumentation and --export=__stack_pointer. */
	mode: 'debug' | 'release';
}

export interface BuildResult {
	exitCode: number;
	/** Combined compiler/linker diagnostics, in clang's text format. */
	diagnostics: string;
}

/** Runs clang.wasm/lld.wasm. Template only: the real implementation is the first item in documents/remaining_work.md. */
export async function build(request: BuildRequest, _log: vscode.OutputChannel): Promise<BuildResult> {
	throw new Error(
		`vscwClang toolchain is not implemented yet: cannot build ${request.sources.length} source file(s) into ${request.output.toString()}. ` +
		`See documents/remaining_work.md, "Milestone 1: compile in the browser".`);
}
