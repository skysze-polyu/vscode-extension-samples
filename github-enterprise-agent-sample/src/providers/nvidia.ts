import * as vscode from 'vscode';
import { OpenAICompatibleChatModelProvider, OpenAICompatibleModelInfo } from './openaiCompatible';

// The NVIDIA NIM API is OpenAI-compatible: https://docs.api.nvidia.com
const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

const NVIDIA_MODELS: OpenAICompatibleModelInfo[] = [
	{
		id: 'meta/llama-3.3-70b-instruct',
		name: 'Llama 3.3 70B (NVIDIA)',
		tooltip: 'Meta Llama 3.3 70B Instruct served by NVIDIA NIM.',
		maxInputTokens: 128000,
		maxOutputTokens: 8192
	},
	{
		id: 'nvidia/llama-3.1-nemotron-70b-instruct',
		name: 'Nemotron 70B (NVIDIA)',
		tooltip: 'NVIDIA Llama 3.1 Nemotron 70B Instruct.',
		maxInputTokens: 128000,
		maxOutputTokens: 8192
	},
	{
		id: 'deepseek-ai/deepseek-r1',
		name: 'DeepSeek R1 (NVIDIA)',
		tooltip: 'DeepSeek R1 served by NVIDIA NIM.',
		maxInputTokens: 128000,
		maxOutputTokens: 8192
	},
	{
		id: 'qwen/qwen2.5-coder-32b-instruct',
		name: 'Qwen2.5 Coder 32B (NVIDIA)',
		tooltip: 'Qwen2.5 Coder 32B Instruct served by NVIDIA NIM.',
		maxInputTokens: 128000,
		maxOutputTokens: 8192
	}
];

export class NvidiaChatModelProvider extends OpenAICompatibleChatModelProvider {
	constructor(secrets: vscode.SecretStorage) {
		super(
			'nvidia',
			'nvidia',
			NVIDIA_BASE_URL,
			NVIDIA_MODELS,
			secrets,
			'github-enterprise-agent-sample.nvidiaApiKey',
			'GitHub Enterprise Agent: Set NVIDIA API Key'
		);
	}
}
