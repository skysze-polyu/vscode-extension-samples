import * as vscode from 'vscode';

export interface OpenAICompatibleModelInfo {
	id: string;
	name: string;
	tooltip: string;
	maxInputTokens: number;
	maxOutputTokens: number;
}

/**
 * Minimal OpenAI-compatible chat completion client shared by the NVIDIA NIM
 * and Mistral model providers. Uses plain fetch and server-sent events, so it
 * works in the desktop and the web extension host.
 */
export abstract class OpenAICompatibleChatModelProvider implements vscode.LanguageModelChatProvider {
	constructor(
		private readonly vendor: string,
		private readonly family: string,
		private readonly baseUrl: string,
		private readonly models: OpenAICompatibleModelInfo[],
		private readonly secrets: vscode.SecretStorage,
		private readonly secretStorageKey: string,
		private readonly apiKeyCommandTitle: string
	) { }

	provideLanguageModelChatInformation(_options: { silent: boolean }, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
		return this.models.map(model => ({
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
