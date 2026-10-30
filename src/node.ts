// The only place the plugin reaches Node.js and Electron. Everything inside
// the vault goes through Obsidian's vault API; these cover the two things it
// can't do, both disclosed in the README:
//
// - Saving an export where the user picks in the system save dialog
//   ("Ask where to save"), which may be outside the vault.
// - Reading installed font files (read-only) to match Word's line heights.
//
// Desktop only; each returns null when Node isn't available.

export interface NodeFs {
	readdirSync(path: string): string[];
	statSync(path: string): { isDirectory(): boolean };
	openSync(path: string, flags: string): number;
	readSync(fd: number, buf: Uint8Array, offset: number, length: number, position: number): number;
	closeSync(fd: number): void;
	promises: { writeFile(path: string, data: Uint8Array): Promise<void> };
}

export interface ElectronLike {
	remote?: {
		dialog: {
			showSaveDialog(opts: {
				title?: string;
				defaultPath?: string;
				filters?: { name: string; extensions: string[] }[];
			}): Promise<{ canceled: boolean; filePath?: string }>;
		};
	};
	shell?: { openPath(path: string): Promise<string> };
}

function nodeRequire(id: string): unknown {
	try {
		return (window as unknown as { require?: (id: string) => unknown }).require?.(id) ?? null;
	} catch {
		return null;
	}
}

export function nodeFs(): NodeFs | null {
	return nodeRequire('fs') as NodeFs | null;
}

export function electron(): ElectronLike | null {
	return nodeRequire('electron') as ElectronLike | null;
}

export function processEnv(): Record<string, string | undefined> {
	return (nodeRequire('process') as { env?: Record<string, string | undefined> } | null)?.env ?? {};
}
