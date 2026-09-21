import OpenAI from 'openai';
import { reviewResponseSchema } from './schema.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const geminiReviewSchema = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string', enum: ['correctness', 'react', 'typescript', 'async', 'security', 'performance', 'reliability'] },
          title: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' },
          suggestion: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['file', 'line', 'severity', 'category', 'title', 'description', 'evidence', 'suggestion', 'confidence'],
      },
    },
  },
  required: ['summary', 'findings'],
};

function safeProviderError(error) {
  const status = Number(error?.status || error?.code);
  const message = String(error?.message || '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/(?:sk|rk|AIza|sk-or-v1)-[A-Za-z0-9_-]+/g, '[secret]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 160);
  const reason = String(error?.name || error?.code || 'request-error')
    .replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'request-error';
  return `${status || reason}${message ? `: ${message}` : ''}`;
}

function retryableProviderError(error) {
  const status = Number(error?.status || error?.code);
  return status === 408 || status === 409 || status === 429 || status >= 500 || error?.name === 'AbortError' || error?.name === 'APIConnectionTimeoutError';
}

function parseJsonResponse(outputText) {
  if (!outputText) throw new Error('returned an empty response');
  const jsonText = String(outputText).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(jsonText);
  } catch (parseError) {
    const start = jsonText.indexOf('{');
    const end = jsonText.lastIndexOf('}');
    if (start < 0 || end <= start) throw parseError;
    return JSON.parse(jsonText.slice(start, end + 1));
  }
}

export class GeminiProvider {
  constructor({ apiKey, model, baseURL = 'https://generativelanguage.googleapis.com/v1beta', timeoutMs = 90000, maxRetries = 2, fetchFn = fetch, sleepFn = sleep } = {}) {
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    if (!model) throw new Error('GEMINI_MODEL is not configured');
    this.apiKey = apiKey;
    this.model = model;
    this.baseURL = baseURL.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetch = fetchFn;
    this.sleep = sleepFn;
    this.provider = 'gemini';
  }

  async review({ system, user, maxOutputTokens = 3500 }) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
          response = await this.fetch(`${this.baseURL}/models/${encodeURIComponent(this.model)}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: system }] },
              contents: [{ role: 'user', parts: [{ text: user }] }],
              generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: geminiReviewSchema,
                maxOutputTokens,
              },
            }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        const payload = await response.json();
        if (!response.ok) {
          const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        const outputText = payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
        return parseJsonResponse(outputText);
      } catch (error) {
        if (!retryableProviderError(error) || attempt >= this.maxRetries) {
          throw new Error(`gemini review failed (${safeProviderError(error)})`);
        }
        await this.sleep(750 * (2 ** attempt));
      }
    }
    throw new Error('gemini review failed');
  }
}

export class OpenAIProvider {
  constructor({ apiKey, model, provider = 'openai', baseURL, defaultHeaders, timeoutMs = 90000, maxRetries = 2, client, sleepFn = sleep } = {}) {
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
        let outputText;
        if (this.provider === 'openrouter') {
          const request = {
            model: this.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            max_tokens: maxOutputTokens,
            // Free-router model support for strict json_schema varies. The
            // prompt carries the schema and validateReview enforces it.
            response_format: { type: 'json_object' },
          };
          let response = await this.client.chat.completions.create(request);
          outputText = response.choices?.[0]?.message?.content;
          // Some free models acknowledge JSON mode but return an empty content
          // field. Retry once without the optional response_format so the
          // schema instruction in the prompt can still be validated locally.
          if (!outputText) {
            const { response_format: _responseFormat, ...plainRequest } = request;
            response = await this.client.chat.completions.create(plainRequest);
            outputText = response.choices?.[0]?.message?.content;
          }
        } else {
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
          outputText = response.output_text;
        }
        if (!outputText) throw new Error(`${this.provider} returned an empty response`);
        const jsonText = String(outputText).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        try {
          return JSON.parse(jsonText);
        } catch (parseError) {
          // Some free models prepend a safety label or other non-JSON text.
          // Recover only a complete top-level object; schema validation still
          // rejects malformed or unsafe findings before publication.
          const start = jsonText.indexOf('{');
          const end = jsonText.lastIndexOf('}');
          if (start < 0 || end <= start) throw parseError;
          return JSON.parse(jsonText.slice(start, end + 1));
        }
      } catch (error) {
        const status = Number(error?.status || error?.code);
        const retryable = status === 408 || status === 409 || status === 429 || status >= 500 || error?.name === 'APIConnectionTimeoutError';
        const safeMessage = String(error?.message || '')
          .replace(/https?:\/\/\S+/gi, '[url]')
          .replace(/(?:sk|rk|sk-or-v1)-[A-Za-z0-9_-]+/g, '[secret]')
          .replace(/[\r\n]+/g, ' ')
          .slice(0, 160);
        const reason = `${String(error?.name || error?.code || 'request-error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80) || 'request-error'}${safeMessage ? `: ${safeMessage}` : ''}`;
        if (!retryable || attempt >= this.maxRetries) throw new Error(`${this.provider} review failed (${status || reason})`);
        const retryAfter = Number(error?.headers?.get?.('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 750 * (2 ** attempt));
      }
    }
    throw new Error(`${this.provider} review failed`);
  }
}

export function resolveProviderConfig(config = process.env) {
  const provider = config.AI_PROVIDER || 'openai';
  if (!['openai', 'openrouter', 'gemini'].includes(provider)) throw new Error(`Unsupported AI_PROVIDER: ${provider}`);

  if (provider === 'gemini') {
    return {
      provider,
      apiKey: config.GEMINI_API_KEY,
      model: config.GEMINI_MODEL || 'gemini-3.8-flash',
      baseURL: config.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    };
  }

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
  const providerConfig = resolveProviderConfig(config);
  return providerConfig.provider === 'gemini'
    ? new GeminiProvider(providerConfig)
    : new OpenAIProvider(providerConfig);
}
