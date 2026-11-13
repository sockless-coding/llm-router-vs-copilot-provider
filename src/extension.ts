import * as vscode from 'vscode';
import { RouterConfig } from './config';
import { SocklessRouterChatProvider } from './provider';

const VENDOR = 'sockless-llm-router';

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Sockless LLM Router');
	const config = new RouterConfig(context.secrets);
	const provider = new SocklessRouterChatProvider(config, output);

	context.subscriptions.push(
		output,
		vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
		// The protocol decides whether models offer the Thinking Effort control, so re-list them.
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('socklessLlmRouter.protocol')) {
				provider.refresh();
			}
		}),
		vscode.commands.registerCommand('socklessLlmRouter.manage', async () => {
			const configured = await config.promptConfigure();
			if (configured) {
				provider.refresh();
				vscode.window.showInformationMessage(
					'Sockless LLM Router: connection saved. Reopen the Copilot model picker to see the updated model list.'
				);
			}
		})
	);
}

export function deactivate(): void { }
