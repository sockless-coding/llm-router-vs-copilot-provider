import * as vscode from 'vscode';
import { RouterClient } from './routerClient';

const CONFIG_SECTION = 'socklessLlmRouter';
const SECRET_API_KEY = 'socklessLlmRouter.apiKey';
export const DEFAULT_BASE_URL = 'http://localhost:5054';

export type RouterProtocol = 'openai' | 'claude';
const DEFAULT_PROTOCOL: RouterProtocol = 'openai';

/**
 * Owns where the router's endpoint URL and API key are stored, and the one prompt flow used to
 * set them up. The URL lives in user settings (so it round-trips with settings sync); the API
 * key lives in SecretStorage, since it's the one piece of this configuration that shouldn't end
 * up in a synced settings.json.
 */
export class RouterConfig {
	constructor(private readonly secrets: vscode.SecretStorage) { }

	getBaseUrl(): string {
		const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('baseUrl', DEFAULT_BASE_URL);
		return configured.trim().replace(/\/+$/, '');
	}

	private async setBaseUrl(value: string): Promise<void> {
		await vscode.workspace.getConfiguration(CONFIG_SECTION).update('baseUrl', value, vscode.ConfigurationTarget.Global);
	}

	/** Which of the router's chat protocols to speak — see the `socklessLlmRouter.protocol` setting. */
	getProtocol(): RouterProtocol {
		const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('protocol', DEFAULT_PROTOCOL);
		return value === 'claude' ? 'claude' : 'openai';
	}

	async getApiKey(): Promise<string | undefined> {
		return this.secrets.get(SECRET_API_KEY);
	}

	private async setApiKey(value: string | undefined): Promise<void> {
		if (value) {
			await this.secrets.store(SECRET_API_KEY, value);
		} else {
			await this.secrets.delete(SECRET_API_KEY);
		}
	}

	async createClient(): Promise<RouterClient> {
		return new RouterClient(this.getBaseUrl() || DEFAULT_BASE_URL, await this.getApiKey());
	}

	/**
	 * Walks the user through setting the endpoint URL and (optional) API key in two input boxes.
	 * Returns true if the URL was saved — even if the user then skipped the API key step, since
	 * that's a valid "no key needed" configuration.
	 */
	async promptConfigure(): Promise<boolean> {
		const url = await vscode.window.showInputBox({
			title: 'Sockless LLM Router: API Endpoint URL',
			prompt: 'The base URL of the router\'s API endpoints (not the admin web UI port).',
			value: this.getBaseUrl() || DEFAULT_BASE_URL,
			placeHolder: DEFAULT_BASE_URL,
			ignoreFocusOut: true,
			validateInput: value => isValidHttpUrl(value) ? undefined : 'Enter a valid http:// or https:// URL'
		});
		if (!url) {
			return false;
		}
		await this.setBaseUrl(url.trim().replace(/\/+$/, ''));

		const hasExistingKey = !!(await this.getApiKey());
		const key = await vscode.window.showInputBox({
			title: 'Sockless LLM Router: API Key (optional)',
			prompt: hasExistingKey
				? 'Enter a new API key, leave blank to keep the current one, or type "clear" to remove it.'
				: 'Only needed if "Require API Key" is enabled in the router\'s gateway settings. Leave blank to skip.',
			password: true,
			ignoreFocusOut: true
		});
		if (key === undefined) {
			// Dismissed (Escape) — the URL change above still stands.
			return true;
		}
		const trimmed = key.trim();
		if (trimmed.toLowerCase() === 'clear') {
			await this.setApiKey(undefined);
		} else if (trimmed.length > 0) {
			await this.setApiKey(trimmed);
		}
		return true;
	}
}

function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}
