import OpenAI from 'openai';
import { reviewResponseSchema } from './schema.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class OpenAIProvider {
  constructor({ apiKey, model, provider = 'openai', baseURL, defaultHeaders, timeoutMs = 45000, maxRetries = 2, client, sleepFn = sleep } = {}) {
    const keyName = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
    const modelName = provider === 'openrouter' ? 'OPENROUTER_MODEL' : 'OPENAI_MODEL';
    if (!apiKey) throw new Error(`${keyName} is not configured`);
    if (!model) throw new Error(`${modelName} is not configured`);
    if (!['openai', 'openrouter'].includes(provider)) throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
    this.provider = provider;
    this.model = model;
    this.maxRetries = maxRetries;
    this.client = client || new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(defaultHeaders ? { defaultHeaders } : {}),
      timeout: timeoutMs,
      maxRetries: 0,
    });
    this.sleep = sleepFn;
  }

  async review({ system, user, maxOutputTokens = 3500 }) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.client.responses.create({
          model: this.model,
          input: [
            { role: 'system', content: [{ type: 'input_text', text: system }] },
            { role: 'user', content: [{ type: 'input_text', text: user }] },
          ],
          max_output_tokens: maxOutputTokens,
          store: false,
          text: {
            format: {
              type: 'json_schema',
              name: 'code_review',
              strict: true,
              schema: reviewResponseSchema,
            },
          },
        });
        if (!response.output_text) throw new Error(`${this.provider} returned an empty response`);
        return JSON.parse(response.output_text);
      } catch (error) {
        const status = Number(error?.status || error?.code);
        const retryable = status === 408 || status === 409 || status === 429 || status >= 500 || error?.name === 'APIConnectionTimeoutError';
        if (!retryable || attempt >= this.maxRetries) throw new Error(`${this.provider} review failed (${status || 'request error'})`);
        const retryAfter = Number(error?.headers?.get?.('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 750 * (2 ** attempt));
      }
    }
    throw new Error(`${this.provider} review failed`);
  }
}

export function resolveProviderConfig(config = process.env) {
  const provider = config.AI_PROVIDER || 'openai';
  if (!['openai', 'openrouter'].includes(provider)) throw new Error(`Unsupported AI_PROVIDER: ${provider}`);

  if (provider === 'openrouter') {
    return {
      provider,
      apiKey: config.OPENROUTER_API_KEY,
      model: config.OPENROUTER_MODEL,
      baseURL: config.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        ...(config.OPENROUTER_SITE_URL ? { 'HTTP-Referer': config.OPENROUTER_SITE_URL } : {}),
        ...(config.OPENROUTER_SITE_NAME ? { 'X-OpenRouter-Title': config.OPENROUTER_SITE_NAME } : {}),
      },
    };
  }

  return {
    provider,
    apiKey: config.OPENAI_API_KEY,
    model: config.OPENAI_MODEL,
    baseURL: config.OPENAI_BASE_URL,
  };
}

export function createProvider(config = process.env) {
  return new OpenAIProvider(resolveProviderConfig(config));
}
