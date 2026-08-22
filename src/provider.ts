import * as vscode from 'vscode';
import { RouterConfig } from './config';
import { RouterApiError } from './routerClient';
import { buildRequestBody, flattenMessageText, toChatInformation } from './convert';

/**
 * Bridges the Sockless LLM Router's OpenAI-compatible API to VS Code's chat model provider
 * contract, so its presets show up in the Copilot model picker with no manual per-model setup —
 * `provideLanguageModelChatInformation` discovers them straight from the router's
 * `/v1/models/capabilities` endpoint.
 */
export class SocklessRouterChatProvider implements vscode.LanguageModelChatProvider {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	constructor(private readonly config: RouterConfig) { }

	/** Tells VS Code to re-query models — called after the connection settings are (re)saved. */
	refresh(): void {
		this.changeEmitter.fire();
	}

	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.config.getBaseUrl()) {
			if (options.silent) {
				return [];
			}
			const configured = await this.config.promptConfigure();
			if (!configured) {
				return [];
			}
		}

		try {
			const client = await this.config.createClient();
			const models = await client.listModelCapabilities(token);
			if (models.length === 0 && !options.silent) {
				vscode.window.showWarningMessage(
					'Sockless LLM Router: connected, but no models are available. Add a server preset in the router\'s admin UI, then reopen the Copilot model picker.'
				);
			}
			return models.map(toChatInformation);
		} catch (err) {
			if (options.silent) {
				return [];
			}
			const message = err instanceof RouterApiError ? err.message : `Unexpected error: ${(err as Error).message}`;
			const choice = await vscode.window.showErrorMessage(`Sockless LLM Router: ${message}`, 'Configure Connection');
			if (choice === 'Configure Connection' && (await this.config.promptConfigure())) {
				return this.provideLanguageModelChatInformation(options, token);
			}
			return [];
		}
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const client = await this.config.createClient();
		const requestBody = buildRequestBody(model, messages, options);
		await client.streamChatCompletion(requestBody, progress, token);
	}

	async provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Promise<number> {
		// The router has no tokenize endpoint today; this rough chars/4 estimate is only used by
		// callers to budget context, not to build the actual request.
		const asText = typeof text === 'string' ? text : flattenMessageText(text);
		return Math.max(1, Math.ceil(asText.length / 4));
	}
}
