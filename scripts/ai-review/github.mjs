const DEFAULT_API = 'https://api.github.com';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class GitHubApiError extends Error {
  constructor(message, status = 0, retryable = false) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.retryable = retryable;
  }
}

export function createGitHubClient({ token, apiBase = DEFAULT_API, timeoutMs = 15000, retries = 2 } = {}) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  async function request(path, options = {}) {
    const url = path.startsWith('http') ? path : `${apiBase}${path}`;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...(options.headers || {}),
          },
          signal: controller.signal,
        });
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text; }
        if (response.ok) return body;
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (retryable && attempt < retries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * (2 ** attempt));
          continue;
        }
        throw new GitHubApiError(`GitHub API ${response.status}: ${body?.message || 'request failed'}`, response.status, retryable);
      } catch (error) {
        if (error instanceof GitHubApiError && !error.retryable) throw error;
        if (attempt >= retries) {
          if (error.name === 'AbortError') throw new GitHubApiError('GitHub API request timed out', 408, true);
          throw error;
        }
        await sleep(500 * (2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new GitHubApiError('GitHub API request failed');
  }
  async function paginate(path, { maxPages = 20 } = {}) {
    const all = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const data = await request(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(data)) return all;
      all.push(...data);
      if (data.length < 100) return all;
    }
    return all;
  }
  return { request, paginate };
}

export async function getPullRequestContext(client, owner, repo, number) {
  return client.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`);
}

export async function getPullRequestFiles(client, owner, repo, number) {
  return client.paginate(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files`);
}
