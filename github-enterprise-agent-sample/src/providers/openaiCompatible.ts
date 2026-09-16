import * as vscode from 'vscode';

export interface OpenAICompatibleModelInfo {
	id: string;
	name: string;
	tooltip: string;
	maxInputTokens: number;
	maxOutputTokens: number;
}

// Id fragments of model families that a chat completion endpoint lists but
// that are not chat models (embeddings, rerankers, guard models, ...).
const NON_CHAT_ID_FRAGMENTS = [
	'embed', 'rerank', 'retriever', 'guard', 'safety', 'topic-control',
	'deplot', 'kosmos', 'fuyu', 'diffusion', 'calibration', 'detector', 'ocr'
];

/**
 * Minimal OpenAI-compatible chat completion client shared by the NVIDIA NIM
 * and Mistral model providers. Uses plain fetch and server-sent events, so it
 * works in the desktop and the web extension host.
 */
export abstract class OpenAICompatibleChatModelProvider implements vscode.LanguageModelChatProvider {
	private static readonly LIVE_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
	private liveModelsCache: { models: OpenAICompatibleModelInfo[]; fetchedAt: number } | undefined;

	constructor(
		private readonly vendor: string,
		private readonly family: string,
		private readonly baseUrl: string,
		private readonly models: OpenAICompatibleModelInfo[],
		private readonly secrets: vscode.SecretStorage,
		private readonly secretStorageKey: string,
		private readonly apiKeyCommandTitle: string
	) { }

	async provideLanguageModelChatInformation(_options: { silent: boolean }, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		// The model catalog of an OpenAI-compatible endpoint changes over time
		// (models get retired and added), so a hardcoded list goes stale. The
		// live catalog is preferred whenever it can be fetched; the static list
		// is the fallback for offline use or endpoints that require a key for
		// discovery while none is configured yet.
		const live = await this.fetchLiveModels(token);
		const models = live.length > 0 ? live : this.models;
		return models.map(model => ({
			id: model.id,
			name: model.name,
			tooltip: model.tooltip,
			family: this.family,
			maxInputTokens: model.maxInputTokens,
			maxOutputTokens: model.maxOutputTokens,
			version: '1.0.0',
			capabilities: {
				toolCalling: false,
				imageInput: false
			}
		}));
	}

	/**
	 * Discovers the models that the endpoint currently serves. Returns an
	 * empty array when the catalog cannot be fetched, so the caller falls
	 * back to the static list.
	 */
	protected async fetchLiveModels(token: vscode.CancellationToken): Promise<OpenAICompatibleModelInfo[]> {
		const cached = this.liveModelsCache;
		if (cached && Date.now() - cached.fetchedAt < OpenAICompatibleChatModelProvider.LIVE_MODELS_CACHE_TTL_MS) {
			return cached.models;
		}

		const apiKey = await this.secrets.get(this.secretStorageKey);
		const headers: Record<string, string> = {};
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}

		try {
			const response = await fetch(`${this.baseUrl}/models`, { headers, signal: toAbortSignal(token) });
			if (!response.ok || !response.body) {
				return [];
			}
			const catalog = await response.json() as { data?: { id?: unknown }[] };
			const ids = (catalog.data ?? [])
				.map(entry => entry.id)
				.filter((id): id is string => typeof id === 'string' && !NON_CHAT_ID_FRAGMENTS.some(fragment => id.includes(fragment)));
			const models = ids.map(id => ({
				id,
				name: id,
				tooltip: `Served by ${this.vendor}.`,
				maxInputTokens: 128000,
				maxOutputTokens: 8192
			}));
			this.liveModelsCache = { models, fetchedAt: Date.now() };
			return models;
		} catch {
			return [];
		}
	}

	async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], _options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		const apiKey = await this.secrets.get(this.secretStorageKey);
		if (!apiKey) {
			throw new Error(`No API key configured for ${this.vendor}. Run the "${this.apiKeyCommandTitle}" command to set one.`);
		}

		const response = await fetch(`${this.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: model.id,
				messages: messages.map(toOpenAIMessage),
				stream: true
			}),
			signal: toAbortSignal(token)
		});

		if (!response.ok || !response.body) {
			throw new Error(`${this.vendor} request failed: ${response.status} ${response.statusText}`);
		}

		// Stream the server-sent events and forward text deltas as they arrive.
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.startsWith('data:')) {
					continue;
				}
				const data = line.slice(5).trim();
				if (data === '[DONE]') {
					return;
				}
				try {
					const delta = JSON.parse(data).choices?.[0]?.delta?.content;
					if (typeof delta === 'string' && delta.length > 0) {
						progress.report(new vscode.LanguageModelTextPart(delta));
					}
				} catch {
					// ignore keep-alive comments and partial frames
				}
			}
		}
	}

	async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, _token: vscode.CancellationToken): Promise<number> {
		const chars = typeof text === 'string' ? text.length : messageText(text).length;
		return Math.ceil(chars / 4);
	}
}

function toOpenAIMessage(message: vscode.LanguageModelChatRequestMessage): { role: string; content: string } {
	const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
	return { role, content: messageText(message) };
}

function messageText(message: string | vscode.LanguageModelChatRequestMessage): string {
	if (typeof message === 'string') {
		return message;
	}
	return message.content.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : '').join('');
}

function toAbortSignal(token: vscode.CancellationToken): AbortSignal {
	const controller = new AbortController();
	if (token.isCancellationRequested) {
		controller.abort();
	} else {
		token.onCancellationRequested(() => controller.abort());
	}
	return controller.signal;
}
