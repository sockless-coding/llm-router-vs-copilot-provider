import * as vscode from 'vscode';

export interface ClaudeContentBlock {
	type: 'text' | 'image' | 'tool_use' | 'tool_result';
	text?: string;
	source?: { type: 'base64'; media_type: string; data: string };
	id?: string;
	name?: string;
	input?: object;
	tool_use_id?: string;
	content?: string;
}

export interface ClaudeMessage {
	role: 'user' | 'assistant';
	content: ClaudeContentBlock[];
}

/**
 * Converts VS Code's chat request messages into the router's Anthropic-compatible wire format.
 * Unlike the OpenAI conversion, a tool result doesn't need to become its own top-level message —
 * Anthropic's Messages API allows a single user message to carry a mix of text and `tool_result`
 * blocks, which is exactly the shape a tool-calling turn produces (one assistant message with
 * `tool_use` blocks, followed by one user message with the matching `tool_result` blocks).
 */
export function toClaudeMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): ClaudeMessage[] {
	return messages.map(message =>
		message.role === vscode.LanguageModelChatMessageRole.Assistant
			? convertAssistantMessage(message)
			: convertUserMessage(message)
	);
}

function convertAssistantMessage(message: vscode.LanguageModelChatRequestMessage): ClaudeMessage {
	const blocks: ClaudeContentBlock[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			if (part.value.length > 0) {
				blocks.push({ type: 'text', text: part.value });
			}
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			blocks.push({ type: 'tool_use', id: part.callId, name: part.name, input: part.input ?? {} });
		}
		// Assistant turns don't carry LanguageModelDataPart (models don't emit image output).
	}

	// Anthropic requires at least one content block per message.
	if (blocks.length === 0) {
		blocks.push({ type: 'text', text: '' });
	}

	return { role: 'assistant', content: blocks };
}

function convertUserMessage(message: vscode.LanguageModelChatRequestMessage): ClaudeMessage {
	const blocks: ClaudeContentBlock[] = [];

	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			blocks.push({ type: 'text', text: part.value });
		} else if (part instanceof vscode.LanguageModelDataPart) {
			if (part.mimeType.startsWith('image/')) {
				blocks.push({
					type: 'image',
					source: { type: 'base64', media_type: part.mimeType, data: Buffer.from(part.data).toString('base64') }
				});
			}
			// Non-image data parts (json/text) have no Anthropic content-block equivalent — dropped.
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			blocks.push({ type: 'tool_result', tool_use_id: part.callId, content: flattenToolResult(part.content) });
		}
	}

	if (blocks.length === 0) {
		blocks.push({ type: 'text', text: '' });
	}

	return { role: 'user', content: blocks };
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

/** Builds the JSON body posted to `/v1/messages` (the router's Anthropic-compatible protocol). */
export function buildClaudeRequestBody(
	model: vscode.LanguageModelChatInformation,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	options: vscode.ProvideLanguageModelChatResponseOptions
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		...options.modelOptions,
		model: model.id,
		messages: toClaudeMessages(messages),
		// Unlike the OpenAI protocol, max_tokens is required by the Anthropic Messages API.
		max_tokens: model.maxOutputTokens,
		stream: true
	};

	if (options.tools && options.tools.length > 0) {
		body.tools = options.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			input_schema: tool.inputSchema ?? {}
		}));
		body.tool_choice = { type: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'any' : 'auto' };
	}

	return body;
}
