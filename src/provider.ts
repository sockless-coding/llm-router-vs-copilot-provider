import * as vscode from 'vscode';
import { RouterConfig } from './config';
import { RouterApiError, RouterModelCapability } from './routerClient';
import { buildOpenAiRequestBody, flattenMessageText, toChatInformation } from './convert';
import { buildClaudeRequestBody } from './convertClaude';
import { ReasoningEffortState } from './reasoningEffortState';

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
	 * whether the model actually supports reasoning effort and which levels it accepts.
	 */
	private readonly capabilitiesById = new Map<string, RouterModelCapability>();

	constructor(
		private readonly config: RouterConfig,
		private readonly output: vscode.OutputChannel,
		private readonly reasoningEffort: ReasoningEffortState
	) { }

	/** Tells VS Code to re-query models — called after the connection settings are (re)saved. */
	refresh(): void {
		this.changeEmitter.fire();
	}

	/** The reasoning-effort levels seen across the last fetched capabilities, for the status bar quick pick. */
	getKnownReasoningEffortOptions(): string[] {
		const seen = new Set<string>();
		for (const capability of this.capabilitiesById.values()) {
			for (const option of capability.reasoning_effort_options ?? []) {
				seen.add(option);
			}
		}
		return [...seen];
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
		if (this.config.getProtocol() === 'claude') {
			await client.streamClaudeMessage(buildClaudeRequestBody(model, messages, options), progress, token);
		} else {
			const reasoningEffort = this.resolveReasoningEffort(model);
			await client.streamChatCompletion(buildOpenAiRequestBody(model, messages, options, reasoningEffort), progress, token);
		}
	}

	/**
	 * Applies the status bar's global effort level to this model only if it actually supports
	 * reasoning effort, and only if that level is one the model's own chat template recognizes
	 * (when the router reported a discrete set) — so picking "High" for a reasoning model never
	 * leaks a `reasoning_effort` field into a request for a model that doesn't understand it.
	 */
	private resolveReasoningEffort(model: vscode.LanguageModelChatInformation): string | undefined {
		const desired = this.reasoningEffort.get();
		if (!desired) {
			return undefined;
		}
		const capability = this.capabilitiesById.get(model.id);
		if (!capability?.supports_reasoning_effort) {
			return undefined;
		}
		const options = capability.reasoning_effort_options ?? [];
		if (options.length > 0 && !options.includes(desired)) {
			return undefined;
		}
		return desired;
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
