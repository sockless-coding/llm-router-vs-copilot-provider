import * as vscode from 'vscode';

const MEMENTO_KEY = 'socklessLlmRouter.reasoningEffort';

/**
 * The single, global reasoning-effort level applied to every model that supports it (see the
 * status bar item in `extension.ts`). Kept in {@link vscode.Memento} rather than a workspace
 * setting since it's a live per-session toggle, not a connection setting a user configures once.
 */
export class ReasoningEffortState {
	private readonly changeEmitter = new vscode.EventEmitter<string | undefined>();
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly memento: vscode.Memento) { }

	/** `undefined` means "auto" — don't override, use each preset's own launch default. */
	get(): string | undefined {
		return this.memento.get<string>(MEMENTO_KEY);
	}

	async set(value: string | undefined): Promise<void> {
		await this.memento.update(MEMENTO_KEY, value);
		this.changeEmitter.fire(value);
	}
}
