import * as vscode from 'vscode';
import { RouterConfig } from './config';
import { SocklessRouterChatProvider } from './provider';

const VENDOR = 'sockless-llm-router';

export function activate(context: vscode.ExtensionContext): void {
	const config = new RouterConfig(context.secrets);
	const provider = new SocklessRouterChatProvider(config);

	context.subscriptions.push(
		vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
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
