/**
 * The handful of fields this extension uses from VS Code's `chatProvider` API proposal
 * (https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatProvider.d.ts).
 *
 * Only fields the extension host forwards WITHOUT a proposal check are declared here, so the
 * extension works in stable VS Code without `enabledApiProposals` (which would block publishing):
 * an editor that doesn't know a field simply ignores it.
 */
declare module 'vscode' {

	export interface LanguageModelChatInformation {
		/**
		 * Total context window (input + output). Shown by the model picker's context-size display.
		 */
		readonly maxContextWindowTokens?: number;

		/**
		 * Per-model options the user can change. A property with `group: 'navigation'` is shown
		 * directly in the model picker — this is how the "Thinking Effort" control is rendered.
		 */
		readonly configurationSchema?: LanguageModelConfigurationSchema;
	}

	export interface ProvideLanguageModelChatResponseOptions {
		/**
		 * The user's resolved values for {@link LanguageModelChatInformation.configurationSchema}:
		 * schema defaults with the user's picker choices applied on top.
		 */
		readonly modelConfiguration?: { readonly [key: string]: any };
	}

	export type LanguageModelConfigurationSchema = {
		readonly properties?: {
			readonly [key: string]: Record<string, any> & {
				/** Labels shown instead of the raw `enum` values; same length and order. */
				readonly enumItemLabels?: string[];
				/** `'navigation'` shows the property as a primary action in the model picker. */
				readonly group?: string;
			};
		};
	};
}
