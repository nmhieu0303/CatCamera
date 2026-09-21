# Advisory AI code review

CatCamera uses two workflows. `PR Review` runs on each pull request and executes the existing static checks without secrets. `AI PR Review` runs from the default branch after that workflow completes, retrieves the pull request diff through the GitHub API, and publishes an advisory review. The AI workflow checks out trusted default-branch reviewer code; it never checks out or executes the pull request source.

## What is reviewed

The reviewer paginates all changed files, then applies bounded limits before sending anything to the configured AI provider:

- `AI_MAX_FILES` defaults to 100 files.
- `AI_MAX_PATCH_CHARS` defaults to 12,000 characters per file.
- `AI_MAX_TOTAL_CHARS` defaults to 60,000 characters per request.
- Binary files, lockfiles, `.env`/credential files, generated output, `node_modules`, and `public/imou-sdk` are skipped.
- Missing or truncated patches are reported as skipped. The summary says `partial` whenever any file is skipped.

Only added right-side lines can receive inline comments. Findings are rejected when the path or line is not present in the reviewable diff. Context is fetched only for a small window around changed lines and is never executed.

## Configuration

Add these values in the repository settings:

1. Open **Settings → Secrets and variables → Actions**.
2. For Gemini API, add `GEMINI_API_KEY` as an Actions secret and set `GEMINI_MODEL` as a repository variable. The default is the current stable `gemini-3.8-flash`; use a model available to the API project and its quota.
3. Set `AI_PROVIDER=gemini` as a repository variable. The workflow defaults to Gemini when it is absent. `GEMINI_BASE_URL` is fixed to `https://generativelanguage.googleapis.com/v1beta` in the workflow.
4. OpenRouter remains available by setting `AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL`.
5. To use OpenAI API instead, set `AI_PROVIDER=openai`, add `OPENAI_API_KEY`, and add `OPENAI_MODEL`.
6. Add `TEAMS_WEBHOOK_URL` as an Actions secret for the Teams Workflows webhook.

Never put any of these values in source, `.env.example`, PR text, comments, or logs. The OpenAI SDK request uses `store: false`, a bounded output size, a timeout, and retries only for transient failures and rate limits. OpenRouter is an external routing service, so review its provider and privacy settings before sending proprietary code.

## Review and reporting behavior

The provider abstraction supports Gemini, OpenAI, and OpenRouter without changing GitHub publishing. Gemini and OpenAI use structured JSON output; OpenRouter Free uses Chat Completions `json_object` mode because free-router model support for strict JSON Schema varies. The prompt carries the schema and the validator enforces it, sanitizes text, validates severity/category, requires a real changed file and added line, deduplicates findings, and caps inline comments.

The reviewer publishes only `COMMENT` reviews. It never approves, requests changes, merges, resolves human threads, or blocks a pull request because of an AI finding. A stable fingerprint prevents duplicate inline comments on reruns. Before publishing, it re-fetches the PR and abandons findings if the head SHA changed.

The summary comment uses `<!-- catcamera-pr-review -->`, so the static and AI workflows update one comment. It reports CI status, AI status (`completed`, `unavailable`, `failed`, or `stale`), finding counts, coverage, and skipped-file reasons. Teams receives a compact Adaptive Card with PR metadata, CI/AI status, counts, summary, coverage, and links; it never receives source code.

## Security model

Fork pull requests do not satisfy the AI workflow's same-repository guard and cannot receive provider keys or `TEAMS_WEBHOOK_URL`. The static workflow runs with read-only contents permission. The AI workflow uses a write token only for PR comments and checks the repository, PR state, and head SHA before publishing. PR descriptions, comments, diffs, and source text are untrusted input; prompt-injection text is treated as data.

## Local testing

No paid API call is made by the test suite:

```bash
npm test
npm run build
node --check server/index.js
```

To test the orchestration without an API call, test the diff, schema, report, and Teams modules under `tests/ai-review/`. For a real review, configure the secrets in GitHub and use **Actions → AI PR Review → Run workflow** with a PR number after `ai-review.yml` has reached the default branch.

## Cost controls and limitations

The reviewer sends only bounded diffs and small context windows, performs one model request per PR run, caps output at 3,500 tokens, and retries transient errors at most twice. Large or binary-heavy PRs can therefore receive a partial review. AI output is advisory and can be wrong; humans remain responsible for correctness and security decisions. The workflow does not prove camera playback works and does not inspect bundled Imou SDK files.

If the configured provider key or model is missing, the AI result is explicitly shown as unavailable and the static CI result remains independent. If Teams is not configured, the notification is skipped without failing CI.
