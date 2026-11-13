import type * as vscode from 'vscode';
import type { RouterModelCapability } from './routerClient';

/**
 * Key of the effort option in a model's `configurationSchema`. Same name Copilot's own BYOK
 * providers use, so the picker treats it as the familiar "Thinking Effort" control.
 */
export const REASONING_EFFORT_KEY = 'reasoningEffort';

/** Used when a preset supports reasoning effort but its chat template doesn't gate on discrete levels. */
const DEFAULT_LEVELS = ['low', 'medium', 'high'];

const LEVEL_DESCRIPTIONS: Record<string, string> = {
	none: 'No reasoning: fastest replies',
	minimal: 'Barely any reasoning',
	low: 'Short reasoning: faster replies',
	medium: 'Balanced reasoning and speed',
	high: 'Thorough reasoning: slower, better on hard problems',
	xhigh: 'Maximum reasoning: slowest'
};

/** The levels a model's Thinking Effort control offers, or `[]` if it doesn't support reasoning effort. */
export function reasoningEffortLevels(model: RouterModelCapability): string[] {
	if (!model.supports_reasoning_effort) {
		return [];
	}
	const options = model.reasoning_effort_options ?? [];
	return options.length > 0 ? options : DEFAULT_LEVELS;
}

/**
 * Builds the schema that makes VS Code show a "Thinking Effort" control for this model in the
 * Copilot model picker. The picker always resolves to a value, so the default is the preset's
 * own `--reasoning-effort` launch default when it has one: leaving it alone behaves as
 * if no effort was sent.
 */
export function buildReasoningEffortSchema(model: RouterModelCapability): vscode.LanguageModelConfigurationSchema | undefined {
	const levels = reasoningEffortLevels(model);
	if (levels.length === 0) {
		return undefined;
	}
	return {
		properties: {
			[REASONING_EFFORT_KEY]: {
				type: 'string',
				title: 'Thinking Effort',
				enum: levels,
				enumItemLabels: levels.map(labelFor),
				enumDescriptions: levels.map(level => LEVEL_DESCRIPTIONS[level] ?? labelFor(level)),
				default: pickDefault(model, levels),
				group: 'navigation'
			}
		}
	};
}

/**
 * The effort to send for this request: the picker's value for this model, but only if the model
 * still supports it and the level is one it accepts, since capabilities can change on the router
 * after VS Code cached a choice.
 */
export function resolveReasoningEffort(
	capability: RouterModelCapability | undefined,
	modelConfiguration: { readonly [key: string]: unknown } | undefined
): string | undefined {
	const chosen = modelConfiguration?.[REASONING_EFFORT_KEY];
	if (typeof chosen !== 'string' || !capability) {
		return undefined;
	}
	return reasoningEffortLevels(capability).includes(chosen) ? chosen : undefined;
}

function pickDefault(model: RouterModelCapability, levels: string[]): string {
	if (model.reasoning_effort && levels.includes(model.reasoning_effort)) {
		return model.reasoning_effort;
	}
	if (levels.includes('medium')) {
		return 'medium';
	}
	return levels[Math.floor((levels.length - 1) / 2)];
}

function labelFor(level: string): string {
	if (level === 'xhigh') {
		return 'Extra High';
	}
	return level.charAt(0).toUpperCase() + level.slice(1);
}
