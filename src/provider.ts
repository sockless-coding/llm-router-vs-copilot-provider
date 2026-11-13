import * as vscode from 'vscode';
import { RouterConfig } from './config';
import { RouterApiError, RouterModelCapability } from './routerClient';
import { buildOpenAiRequestBody, flattenMessageText, toChatInformation } from './convert';
import { buildClaudeRequestBody } from './convertClaude';
import { resolveReasoningEffort } from './reasoningEffort';

/**
 * Bridges the Sockless LLM Router's OpenAI-compatible API to VS Code's chat model provider
 * contract, so its presets show up in the Copilot model picker with no manual per-model setup —
 * `provideLanguageModelChatInformation` discovers them straight from the router's
 * `/v1/models/capabilities` endpoint.
 */
export class SocklessRouterChatProvider implements vscode.LanguageModelChatProvider {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

	/**
	 * The capabilities behind the last picker listing, by model id — `provideLanguageModelChatResponse`
	 * only gets the plain {@link vscode.LanguageModelChatInformation}, so this is how it finds out
	 * which reasoning-effort levels the model accepts and whether it was loaded.
	 */
	private readonly capabilitiesById = new Map<string, RouterModelCapability>();

	constructor(
		private readonly config: RouterConfig,
		private readonly output: vscode.OutputChannel
	) { }

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
			this.output.appendLine(`[capabilities] GET /v1/models/capabilities -> ${JSON.stringify(models)}`);
			if (models.length === 0 && !options.silent) {
				vscode.window.showWarningMessage(
					'Sockless LLM Router: connected, but no models are available. Add a server preset in the router\'s admin UI, then reopen the Copilot model picker.'
				);
			}
			this.capabilitiesById.clear();
			for (const model of models) {
				this.capabilitiesById.set(model.id, model);
			}
			// The router only translates reasoning effort on its OpenAI-compatible path, so the
			// picker's Thinking Effort control is hidden while the claude protocol is selected.
			const offerReasoningEffort = this.config.getProtocol() === 'openai';
			return models.map(model => toChatInformation(model, offerReasoningEffort));
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
		const capability = this.capabilitiesById.get(model.id);
		const wasLoaded = capability?.loaded;
		try {
			if (this.config.getProtocol() === 'claude') {
				await client.streamClaudeMessage(buildClaudeRequestBody(model, messages, options), progress, token);
			} else {
				const reasoningEffort = resolveReasoningEffort(capability, options.modelConfiguration);
				await client.streamChatCompletion(buildOpenAiRequestBody(model, messages, options, reasoningEffort), progress, token);
			}
		} finally {
			// A request for a model that wasn't loaded makes the router load it, possibly evicting
			// another one, so the picker's load-state tags are stale until it re-queries.
			if (!wasLoaded) {
				this.refresh();
			}
		}
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
