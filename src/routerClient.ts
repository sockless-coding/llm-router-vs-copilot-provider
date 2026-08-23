import * as vscode from 'vscode';

export interface RouterModelCapability {
	id: string;
	name: string;
	context_length: number;
	max_output_tokens: number;
	vision: boolean;
	tool_calling: boolean;
	parameter_size?: string;
	quantization?: string;
	/** Whether this preset's chat template reads a reasoning-effort-style variable. */
	supports_reasoning_effort?: boolean;
	/** The effort this preset is launched with by default, if configured. */
	reasoning_effort?: string | null;
	/** Discrete effort levels the chat template gates on, e.g. ["low", "medium", "high"]. */
	reasoning_effort_options?: string[];
}

/** An error the router (or the network) surfaced, with a message already fit to show the user. */
export class RouterApiError extends Error {
	constructor(message: string, readonly status?: number) {
		super(message);
	}
}

interface PendingToolCall {
	id: string;
	name: string;
	arguments: string;
}

/** Talks to the router's `/v1` endpoints — both the OpenAI- and Anthropic-compatible protocols. */
export class RouterClient {
	constructor(private readonly baseUrl: string, private readonly apiKey: string | undefined) { }

	async listModelCapabilities(token: vscode.CancellationToken): Promise<RouterModelCapability[]> {
		const { signal, dispose } = bindCancellation(token);
		try {
			const response = await this.request('/v1/models/capabilities', { signal });
			if (!response.ok) {
				throw new RouterApiError(await describeError(response), response.status);
			}
			const body = (await response.json()) as { data?: RouterModelCapability[] };
			return body.data ?? [];
		} catch (err) {
			throw toRouterApiError(err, this.baseUrl);
		} finally {
			dispose();
		}
	}

	/** Streams a chat response over the router's OpenAI-compatible `/v1/chat/completions`. */
	async streamChatCompletion(
		requestBody: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		await this.streamSse('/v1/chat/completions', requestBody, consumeOpenAiSse, progress, token);
	}

	/** Streams a chat response over the router's Anthropic-compatible `/v1/messages`. */
	async streamClaudeMessage(
		requestBody: Record<string, unknown>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		await this.streamSse('/v1/messages', requestBody, consumeClaudeSse, progress, token);
	}

	private async streamSse(
		path: string,
		requestBody: Record<string, unknown>,
		consume: (body: ReadableStream<Uint8Array>, progress: vscode.Progress<vscode.LanguageModelResponsePart>) => Promise<void>,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		const { signal, dispose } = bindCancellation(token);
		try {
			const response = await this.request(path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody),
				signal
			});
			if (!response.ok || !response.body) {
				throw new RouterApiError(await describeError(response), response.status);
			}
			await consume(response.body, progress);
		} catch (err) {
			if (token.isCancellationRequested) {
				return;
			}
			throw toRouterApiError(err, this.baseUrl);
		} finally {
			dispose();
		}
	}

	private request(path: string, init: RequestInit): Promise<Response> {
		const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
		if (this.apiKey) {
			headers['Authorization'] = `Bearer ${this.apiKey}`;
		}
		return fetch(`${this.baseUrl}${path}`, { ...init, headers });
	}
}

function bindCancellation(token: vscode.CancellationToken): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const subscription = token.onCancellationRequested(() => controller.abort());
	return { signal: controller.signal, dispose: () => subscription.dispose() };
}

function toRouterApiError(err: unknown, baseUrl: string): RouterApiError {
	if (err instanceof RouterApiError) {
		return err;
	}
	const message = err instanceof Error ? err.message : String(err);
	return new RouterApiError(`Could not reach ${baseUrl} (${message})`);
}

async function describeError(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { error?: { message?: string }; message?: string };
		const message = body.error?.message ?? body.message;
		if (message) {
			return `${message} (HTTP ${response.status})`;
		}
	} catch {
		// Body wasn't JSON — fall through to a generic status-based message.
	}
	if (response.status === 401 || response.status === 403) {
		return 'Invalid or missing API key.';
	}
	return `HTTP ${response.status} ${response.statusText}`;
}

/** Reads a `data: <json>` SSE stream, calling `onPayload` for each non-`[DONE]` line's JSON. */
async function readDataLines(
	body: ReadableStream<Uint8Array>,
	onPayload: (payload: string) => 'continue' | 'done'
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				return;
			}
			buffer += decoder.decode(value, { stream: true });

			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (!line.startsWith('data:')) {
					continue;
				}
				const payload = line.slice(5).trim();
				if (onPayload(payload) === 'done') {
					return;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Consumes the OpenAI-protocol `/v1/chat/completions` SSE stream. Text deltas are reported
 * immediately since VS Code can render them incrementally. Tool calls can't be: the router
 * streams each call's `arguments` as a partial JSON string across many chunks (standard OpenAI
 * streaming behavior), and {@link vscode.LanguageModelToolCallPart} needs a single parsed object —
 * so tool call fragments are accumulated by index and only reported once a chunk's `finish_reason`
 * shows the turn is complete.
 */
async function consumeOpenAiSse(
	body: ReadableStream<Uint8Array>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>
): Promise<void> {
	const pendingToolCalls = new Map<number, PendingToolCall>();

	await readDataLines(body, payload => {
		if (payload === '[DONE]') {
			flushOpenAiToolCalls(pendingToolCalls, progress);
			return 'done';
		}
		processOpenAiChunk(payload, pendingToolCalls, progress);
		return 'continue';
	});

	// Safety net in case a stream ends without a final finish_reason chunk or a [DONE] line.
	flushOpenAiToolCalls(pendingToolCalls, progress);
}

function processOpenAiChunk(
	payload: string,
	pendingToolCalls: Map<number, PendingToolCall>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
	let chunk: any;
	try {
		chunk = JSON.parse(payload);
	} catch {
		return;
	}

	const choice = chunk?.choices?.[0];
	if (!choice) {
		return;
	}

	const delta = choice.delta ?? {};
	if (typeof delta.content === 'string' && delta.content.length > 0) {
		progress.report(new vscode.LanguageModelTextPart(delta.content));
	}

	if (Array.isArray(delta.tool_calls)) {
		for (const toolCallDelta of delta.tool_calls) {
			const index: number = toolCallDelta.index ?? 0;
			const existing = pendingToolCalls.get(index);
			const id = toolCallDelta.id ?? existing?.id ?? '';
			const name = toolCallDelta.function?.name ?? existing?.name ?? '';
			const argsFragment: string = toolCallDelta.function?.arguments ?? '';
			pendingToolCalls.set(index, {
				id,
				name,
				arguments: (existing?.arguments ?? '') + argsFragment
			});
		}
	}

	if (choice.finish_reason) {
		flushOpenAiToolCalls(pendingToolCalls, progress);
	}
}

function flushOpenAiToolCalls(
	pendingToolCalls: Map<number, PendingToolCall>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>
): void {
	if (pendingToolCalls.size === 0) {
		return;
	}
	const ordered = [...pendingToolCalls.entries()].sort(([a], [b]) => a - b);
	for (const [, call] of ordered) {
		reportToolCall(call, progress);
	}
	pendingToolCalls.clear();
}

/**
 * Consumes the Anthropic-protocol `/v1/messages` SSE stream. Unlike the OpenAI protocol, a
 * `tool_use` content block is explicitly closed by a `content_block_stop` event, so tool calls
 * can be flushed as soon as their block closes instead of waiting for the whole turn to finish.
 * `thinking_delta` events (extended reasoning) are intentionally not surfaced: there is no stable
 * VS Code response part for reasoning content, the same limitation the OpenAI path has for
 * `reasoning_content`.
 */
async function consumeClaudeSse(
	body: ReadableStream<Uint8Array>,
	progress: vscode.Progress<vscode.LanguageModelResponsePart>
): Promise<void> {
	const pendingToolBlocks = new Map<number, PendingToolCall>();

	await readDataLines(body, payload => {
		let event: any;
		try {
			event = JSON.parse(payload);
		} catch {
			return 'continue';
		}

		switch (event.type) {
			case 'content_block_start': {
				const block = event.content_block;
				if (block?.type === 'tool_use') {
					pendingToolBlocks.set(event.index, { id: block.id ?? '', name: block.name ?? '', arguments: '' });
				}
				break;
			}
			case 'content_block_delta': {
				const delta = event.delta ?? {};
				if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
					progress.report(new vscode.LanguageModelTextPart(delta.text));
				} else if (delta.type === 'input_json_delta') {
					const pending = pendingToolBlocks.get(event.index);
					if (pending) {
						pending.arguments += delta.partial_json ?? '';
					}
				}
				break;
			}
			case 'content_block_stop': {
				const pending = pendingToolBlocks.get(event.index);
				if (pending) {
					reportToolCall(pending, progress);
					pendingToolBlocks.delete(event.index);
				}
				break;
			}
			case 'message_stop':
				return 'done';
			default:
				break;
		}
		return 'continue';
	});
}

function reportToolCall(call: PendingToolCall, progress: vscode.Progress<vscode.LanguageModelResponsePart>): void {
	let input: object = {};
	try {
		input = call.arguments.trim().length > 0 ? JSON.parse(call.arguments) : {};
	} catch {
		// Malformed/truncated arguments — report the tool call with empty input rather than
		// dropping it silently, so the caller at least knows a call was attempted.
	}
	progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
}
