import * as vscode from 'vscode';
import { RouterConfig } from './config';
import { SocklessRouterChatProvider } from './provider';
import { ReasoningEffortState } from './reasoningEffortState';

const VENDOR = 'sockless-llm-router';

/** Fallback shown in the reasoning-effort quick pick before any capabilities have been fetched. */
const DEFAULT_REASONING_EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh'];

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Sockless LLM Router');
	const config = new RouterConfig(context.secrets);
	const reasoningEffort = new ReasoningEffortState(context.globalState);
	const provider = new SocklessRouterChatProvider(config, output, reasoningEffort);

	const statusBarItem = vscode.window.createStatusBarItem('socklessLlmRouter.reasoningEffort', vscode.StatusBarAlignment.Right);
	statusBarItem.name = 'Sockless LLM Router: Reasoning Effort';
	statusBarItem.command = 'socklessLlmRouter.setReasoningEffort';
	statusBarItem.tooltip = 'Sockless LLM Router: reasoning effort for models that support it (applies via the openai protocol only)';
	const updateStatusBarItem = () => {
		const value = reasoningEffort.get();
		statusBarItem.text = `$(sparkle) Reasoning: ${value ? capitalize(value) : 'Auto'}`;
	};
	updateStatusBarItem();
	statusBarItem.show();

	context.subscriptions.push(
		output,
		statusBarItem,
		reasoningEffort.onDidChange(updateStatusBarItem),
		vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
		vscode.commands.registerCommand('socklessLlmRouter.manage', async () => {
			const configured = await config.promptConfigure();
			if (configured) {
				provider.refresh();
				vscode.window.showInformationMessage(
					'Sockless LLM Router: connection saved. Reopen the Copilot model picker to see the updated model list.'
				);
			}
		}),
		vscode.commands.registerCommand('socklessLlmRouter.setReasoningEffort', async () => {
			const known = provider.getKnownReasoningEffortOptions();
			const levels = known.length > 0 ? known : DEFAULT_REASONING_EFFORT_OPTIONS;
			const current = reasoningEffort.get();

			const items: vscode.QuickPickItem[] = [
				{ label: 'Auto', description: "Use each preset's own --reasoning-effort launch default", picked: current === undefined },
				...levels.map(level => ({ label: capitalize(level), picked: current === level }))
			];
			const picked = await vscode.window.showQuickPick(items, {
				title: 'Sockless LLM Router: Reasoning Effort',
				placeHolder: 'Applied only to models that support it (openai protocol only)'
			});
			if (!picked) {
				return;
			}
			await reasoningEffort.set(picked.label === 'Auto' ? undefined : picked.label.toLowerCase());
		})
	);
}

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

export function deactivate(): void { }
