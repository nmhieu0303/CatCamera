import fs from 'node:fs/promises';
import process from 'node:process';
import { createGitHubClient, getPullRequestContext, getPullRequestFiles } from './github.mjs';
import { collectReviewableFiles, changedLinesMap } from './diff.mjs';
import { retrieveBoundedContext } from './context.mjs';
import { buildReviewPrompt, SYSTEM_PROMPT } from './prompt.mjs';
import { createProvider, resolveProviderConfig } from './provider.mjs';
import { buildSummaryBody, findingComment, SUMMARY_MARKER } from './report.mjs';
import { buildTeamsAdaptiveCard, sendTeamsWebhook } from './teams.mjs';
import { validateReview } from './schema.mjs';
import { isStalePullRequest, isTrustedPullRequest } from './guards.mjs';

const json = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const env = process.env;

function eventPullRequestNumber(event) {
  if (env.PR_NUMBER) return Number(env.PR_NUMBER);
  if (event.inputs?.pr_number) return Number(event.inputs.pr_number);
  return Number(event.workflow_run?.pull_requests?.[0]?.number || 0);
}

function repoParts() {
  const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is required');
  return { owner, repo };
}

function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/(?:sk|rk)-[A-Za-z0-9_-]+/g, '[secret]')
    .slice(0, 500);
}

async function getCiResults(client, owner, repo, event) {
  const runId = event.workflow_run?.id;
  if (!runId) return { lint: 'not-run', types: 'not-run', backend: 'not-run', assets: 'not-run', tests: 'not-run', build: 'not-run' };
  const jobs = await client.paginate(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`);
  const source = jobs.find(job => job.name === 'Source checks');
  const steps = new Map((source?.steps || []).map(step => [step.name, step.conclusion || 'not-run']));
  const result = name => steps.get(name) || 'not-run';
  return {
    lint: result('ESLint (if configured)'),
    types: result('TypeScript type check'),
    backend: result('Backend syntax check'),
    assets: result('Verify Imou SDK assets'),
    tests: result('Tests (if configured)'),
    build: result('Frontend and backend build'),
  };
}

async function upsertSummary(client, owner, repo, pullRequest, body) {
  const comments = await client.paginate(`/repos/${owner}/${repo}/issues/${pullRequest.number}/comments`);
  const existing = comments.find(comment => comment.body?.includes(SUMMARY_MARKER));
  if (existing) {
    await client.request(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
    return existing.id;
  }
  const created = await client.request(`/repos/${owner}/${repo}/issues/${pullRequest.number}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  return created.id;
}

async function publishInlineComments(client, owner, repo, pullRequest, findings) {
  if (!findings.length) return { published: 0, skipped: 0 };
  const existing = await client.paginate(`/repos/${owner}/${repo}/pulls/${pullRequest.number}/comments`);
  const existingFingerprints = new Set(existing.flatMap(comment => {
    const match = String(comment.body || '').match(/<!-- catcamera-finding:([a-f0-9]+) -->/);
    return match ? [match[1]] : [];
  }));
  const pending = findings.filter(finding => !existingFingerprints.has(finding.fingerprint));
  if (!pending.length) return { published: 0, skipped: findings.length };
  const comments = pending.map(finding => ({
    path: finding.file,
    line: finding.line,
    side: 'RIGHT',
    body: findingComment(finding),
  }));
  const reviewBody = `AI advisory review found ${pending.length} actionable issue(s). This is a COMMENT review only; it does not approve or block the pull request.`;
  try {
    await client.request(`/repos/${owner}/${repo}/pulls/${pullRequest.number}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ commit_id: pullRequest.head.sha, body: reviewBody, event: 'COMMENT', comments }),
    });
    return { published: pending.length, skipped: findings.length - pending.length };
  } catch (error) {
    // A single invalid position must not discard every valid finding.
    let published = 0;
    for (const comment of comments) {
      try {
        await client.request(`/repos/${owner}/${repo}/pulls/${pullRequest.number}/comments`, {
          method: 'POST',
          body: JSON.stringify({ ...comment, commit_id: pullRequest.head.sha }),
        });
        published += 1;
      } catch {
        // The summary still reports the finding; GitHub rejected its position.
      }
    }
    return { published, skipped: findings.length - published, fallback: safeError(error) };
  }
}

async function main() {
  const event = await json(env.GITHUB_EVENT_PATH || '/dev/null');
  const { owner, repo } = repoParts();
  const number = eventPullRequestNumber(event);
  if (!number) throw new Error('Could not determine pull request number');
  const client = createGitHubClient({ token: env.GITHUB_TOKEN });
  let pullRequest = await getPullRequestContext(client, owner, repo, number);
  if (!isTrustedPullRequest(pullRequest, `${owner}/${repo}`) || pullRequest.state !== 'open') {
    console.log(`AI review skipped: pull request #${number} is not open in this repository.`);
    return;
  }
  if (event.workflow_run?.head_sha && event.workflow_run.head_sha !== pullRequest.head.sha) {
    console.log('AI review skipped: triggering workflow run is stale.');
    return;
  }

  const ci = await getCiResults(client, owner, repo, event);
  const runUrl = event.workflow_run?.html_url || `${env.GITHUB_SERVER_URL || 'https://github.com'}/${owner}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  let ai = { status: 'unavailable', summary: 'AI review is not configured.', findings: [], coverage: { filesChanged: 0, filesReviewed: 0, filesSkipped: 0, partial: true, skipped: [] } };
  try {
    const files = await getPullRequestFiles(client, owner, repo, number);
    const review = collectReviewableFiles(files);
    ai.coverage = review;
    if (!review.reviewed.length) {
      ai = { ...ai, status: 'completed', summary: 'No reviewable source files were present in this pull request.' };
    } else {
      const providerConfig = resolveProviderConfig(env);
      if (!providerConfig.apiKey || !providerConfig.model) {
        const keyName = providerConfig.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
        const modelName = providerConfig.provider === 'openrouter' ? 'OPENROUTER_MODEL' : 'OPENAI_MODEL';
        ai = { ...ai, status: 'unavailable', error: `${keyName} or ${modelName} is not configured.` };
      } else {
        const context = await retrieveBoundedContext(client, owner, repo, pullRequest.head.sha, review.reviewed);
        const provider = createProvider(env);
        const raw = await provider.review({ system: SYSTEM_PROMPT, user: buildReviewPrompt({ pullRequest, review, context }) });
        const validated = validateReview(raw, { reviewableFiles: new Set(review.reviewed.map(item => item.filename)), changedLinesByFile: changedLinesMap(review) });
        if (!validated.ok) {
          ai = { ...ai, status: 'failed', error: validated.error };
        } else {
          ai = { ...ai, status: 'completed', summary: validated.summary, findings: validated.findings, rejectedFindings: validated.rejected };
        }
      }
    }
  } catch (error) {
    ai = { ...ai, status: 'failed', error: safeError(error) };
  }

  const latest = await getPullRequestContext(client, owner, repo, number);
  if (isStalePullRequest(pullRequest.head.sha, latest)) {
    ai = { ...ai, status: 'stale', findings: [], error: 'Pull request changed or closed during analysis; findings were not published.' };
    pullRequest = latest;
  } else {
    const publication = await publishInlineComments(client, owner, repo, pullRequest, ai.findings || []);
    ai = { ...ai, publishedFindings: publication.published, duplicateFindings: publication.skipped };
  }

  const summary = buildSummaryBody({ pullRequest, ci, ai, runUrl });
  await upsertSummary(client, owner, repo, pullRequest, summary);
  const teams = await sendTeamsWebhook(env.TEAMS_WEBHOOK_URL, buildTeamsAdaptiveCard({
    repository: `${owner}/${repo}`,
    pullRequest,
    ciStatus: event.workflow_run?.conclusion || 'unknown',
    ai,
    workflowUrl: runUrl,
  }));
  console.log(JSON.stringify({ status: ai.status, filesReviewed: ai.coverage.filesReviewed, filesSkipped: ai.coverage.filesSkipped, findings: ai.findings?.length || 0, teamsSent: teams.sent, teamsStatus: teams.status || null }));
}

main().catch(error => {
  console.error(`AI review orchestration failed: ${safeError(error)}`);
  process.exitCode = 1;
});
