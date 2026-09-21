import OpenAI from 'openai';
import { reviewResponseSchema } from './schema.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class OpenAIProvider {
  constructor({ apiKey, model, timeoutMs = 45000, maxRetries = 2, client, sleepFn = sleep } = {}) {
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
    if (!model) throw new Error('OPENAI_MODEL is not configured');
    this.model = model;
    this.maxRetries = maxRetries;
    this.client = client || new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });
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
        if (!response.output_text) throw new Error('OpenAI returned an empty response');
        return JSON.parse(response.output_text);
      } catch (error) {
        const status = Number(error?.status || error?.code);
        const retryable = status === 408 || status === 409 || status === 429 || status >= 500 || error?.name === 'APIConnectionTimeoutError';
        if (!retryable || attempt >= this.maxRetries) throw new Error(`OpenAI review failed (${status || 'request error'})`);
        const retryAfter = Number(error?.headers?.get?.('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 750 * (2 ** attempt));
      }
    }
    throw new Error('OpenAI review failed');
  }
}

export function createProvider(config = process.env) {
  if (config.AI_PROVIDER && config.AI_PROVIDER !== 'openai') throw new Error(`Unsupported AI_PROVIDER: ${config.AI_PROVIDER}`);
  return new OpenAIProvider({ apiKey: config.OPENAI_API_KEY, model: config.OPENAI_MODEL });
}
