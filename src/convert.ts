import * as vscode from 'vscode';
import type { RouterModelCapability } from './routerClient';

export interface RouterContentPart {
	type: 'text' | 'image_url';
	text?: string;
	image_url?: { url: string };
}

export interface RouterToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export interface RouterChatMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string | RouterContentPart[] | null;
	name?: string;
	tool_calls?: RouterToolCall[];
	tool_call_id?: string;
}

/**
 * Converts VS Code's chat request messages into the router's OpenAI-compatible wire format.
 * There is no "system" role in {@link vscode.LanguageModelChatMessageRole} — Copilot folds
 * instructions into a user message — so only User/Assistant need mapping. Tool results arrive as
 * a {@link vscode.LanguageModelToolResultPart} embedded in a User message's content and must be
 * split out into their own `role: "tool"` message, since that's a separate message on the wire.
 */
export function toRouterMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): RouterChatMessage[] {
	const result: RouterChatMessage[] = [];
	for (const message of messages) {
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			result.push(convertAssistantMessage(message));
		} else {
			result.push(...convertUserMessage(message));
		}
	}
	return result;
}

function convertAssistantMessage(message: vscode.LanguageModelChatRequestMessage): RouterChatMessage {
	const textParts: string[] = [];
	const toolCalls: RouterToolCall[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			textParts.push(part.value);
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			toolCalls.push({
				id: part.callId,
				type: 'function',
				function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) }
			});
		}
		// Assistant turns don't carry LanguageModelDataPart (models don't emit image output),
		// so there's nothing else to translate here.
	}

	const text = textParts.join('');
	const msg: RouterChatMessage = {
		role: 'assistant',
		// llama.cpp rejects an assistant message with neither content nor tool_calls, so only
		// send null content when there ARE tool calls to carry the message instead.
		content: text.length > 0 ? text : (toolCalls.length > 0 ? null : ''),
		name: message.name
	};
	if (toolCalls.length > 0) {
		msg.tool_calls = toolCalls;
	}
	return msg;
}

function convertUserMessage(message: vscode.LanguageModelChatRequestMessage): RouterChatMessage[] {
	const out: RouterChatMessage[] = [];
	let parts: RouterContentPart[] = [];

	const flushText = () => {
		if (parts.length === 0) {
			return;
		}
		const content = parts.length === 1 && parts[0].type === 'text' ? (parts[0].text ?? '') : parts;
		out.push({ role: 'user', content, name: message.name });
		parts = [];
	};

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			parts.push({ type: 'text', text: part.value });
		} else if (part instanceof vscode.LanguageModelDataPart) {
			if (part.mimeType.startsWith('image/')) {
				const base64 = Buffer.from(part.data).toString('base64');
				parts.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${base64}` } });
			}
			// Non-image data parts (json/text) have no OpenAI content-part equivalent — dropped.
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			// A tool result is its own message on the wire, so flush any accumulated text first
			// to keep message order intact.
			flushText();
			out.push({ role: 'tool', content: flattenToolResult(part.content), tool_call_id: part.callId });
		}
	}
	flushText();

	return out;
}

function flattenToolResult(content: readonly unknown[]): string {
	const chunks: string[] = [];
	for (const item of content) {
		if (item instanceof vscode.LanguageModelTextPart) {
			chunks.push(item.value);
		} else if (item instanceof vscode.LanguageModelDataPart && item.mimeType === 'application/json') {
			chunks.push(Buffer.from(item.data).toString('utf8'));
		}
	}
	return chunks.join('\n');
}

export function flattenMessageText(message: vscode.LanguageModelChatRequestMessage): string {
	return message.content
		.map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
		.join('');
}

/** Builds the JSON body posted to `/v1/chat/completions` (the router's OpenAI-compatible protocol). */
export function buildOpenAiRequestBody(
	model: vscode.LanguageModelChatInformation,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		...options.modelOptions,
		model: model.id,
		messages: toRouterMessages(messages),
		stream: true
	};

	if (options.tools && options.tools.length > 0) {
		body.tools = options.tools.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema ?? {}
			}
		}));
		body.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
	}

	return body;
}

/** Maps a router model-capabilities entry to what VS Code needs to list it in the model picker. */
export function toChatInformation(model: RouterModelCapability): vscode.LanguageModelChatInformation {
	const contextLength = model.context_length > 0 ? model.context_length : 4096;
	const maxOutputTokens = Math.max(1, Math.min(model.max_output_tokens || contextLength, contextLength - 1));
	const maxInputTokens = Math.max(1, contextLength - maxOutputTokens);
	const detail = [model.parameter_size, model.quantization].filter(Boolean).join(' · ');

	return {
		id: model.id,
		name: model.name || model.id,
		family: 'sockless-llm-router',
		version: '1.0.0',
		maxInputTokens,
		maxOutputTokens,
		detail: detail.length > 0 ? detail : undefined,
		capabilities: {
			toolCalling: model.tool_calling,
			imageInput: model.vision
		}
	};
}
