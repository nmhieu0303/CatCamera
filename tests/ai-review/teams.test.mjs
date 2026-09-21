import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTeamsAdaptiveCard, sendTeamsWebhook } from '../../scripts/ai-review/teams.mjs';

const pullRequest = {
  number: 42,
  title: 'Implement cat behavior tracking',
  html_url: 'https://github.com/nmhieu0303/CatCamera/pull/42',
  user: { login: 'reviewer' },
  head: { sha: 'abcdef1234567890abcdef1234567890abcdef12', ref: 'feature/cats' },
  base: { ref: 'main' },
};
const coverage = { filesChanged: 5, filesReviewed: 4, filesSkipped: 1, partial: true, skipped: [{ file: 'dist/app.js', reason: 'generated-vendor-or-bundled-asset' }] };
const finding = (severity, line, title = `${severity} issue`) => ({
  file: 'src/hooks/useCamera.ts', line, severity, category: 'reliability', title,
  description: 'The resource is not released on every lifecycle path.', evidence: 'The cleanup branch is missing.', suggestion: 'Release the resource in the cleanup function.', confidence: 0.9,
});
const card = payload => payload.attachments[0].content;
const text = payload => JSON.stringify(payload);

function baseAi(overrides = {}) {
  return { status: 'completed', summary: 'AI found actionable issues.', findings: [finding('high', 84)], coverage: { filesChanged: 1, filesReviewed: 1, filesSkipped: 0, partial: false }, ...overrides };
}

test('renders a completed review dashboard with independent CI and AI states', () => {
  const payload = buildTeamsAdaptiveCard({ repository: 'nmhieu0303/CatCamera', pullRequest, ciStatus: 'failure', ai: baseAi(), workflowUrl: 'https://github.com/nmhieu0303/CatCamera/actions/runs/42', diffStats: { filesChanged: 1, additions: 4, deletions: 2 } });
  const serialized = text(payload);
  assert.equal(card(payload).version, '1.2');
  assert.match(serialized, /CI STATUS/);
  assert.match(serialized, /FAILED/);
  assert.match(serialized, /AI REVIEW STATUS/);
  assert.match(serialized, /REVIEW COMPLETED/);
  assert.match(serialized, /4/);
  assert.match(serialized, /2/);
});

test('shows severity counts, top three findings, and a full review hint', () => {
  const findings = [finding('low', 10), finding('critical', 20), finding('medium', 30), finding('high', 40), finding('low', 50)];
  const payload = buildTeamsAdaptiveCard({ repository: 'a/b', pullRequest, ciStatus: 'success', ai: baseAi({ findings, coverage: { filesChanged: 5, filesReviewed: 5, filesSkipped: 0, partial: false } }), workflowUrl: 'https://github.com/a/b/actions/runs/1' });
  const serialized = text(payload);
  assert.match(serialized, /CRITICAL/);
  assert.match(serialized, /HIGH/);
  assert.match(serialized, /MEDIUM/);
  assert.match(serialized, /View all 5 findings/);
  assert.equal((serialized.match(/View code/g) || []).length, 3);
});

test('does not show unavailable findings as zero counts after an AI failure', () => {
  const payload = buildTeamsAdaptiveCard({ repository: 'a/b', pullRequest, ciStatus: 'success', ai: { status: 'failed', error: 'Invalid AI response.', findings: [], coverage }, workflowUrl: 'https://github.com/a/b/actions/runs/1' });
  const serialized = text(payload);
  assert.match(serialized, /REVIEW FAILED/);
  assert.match(serialized, /FINDINGS: UNAVAILABLE/);
  assert.doesNotMatch(serialized, /FINDINGS SUMMARY/);
  assert.match(serialized, /Invalid AI response/);
});

test('renders zero findings only for a completed clean review', () => {
  const payload = buildTeamsAdaptiveCard({ repository: 'a/b', pullRequest, ciStatus: 'success', ai: baseAi({ summary: '', findings: [] }), workflowUrl: 'https://github.com/a/b/actions/runs/1' });
  const serialized = text(payload);
  assert.match(serialized, /REVIEW COMPLETED/);
  assert.match(serialized, /No issues reported by AI/);
  assert.doesNotMatch(serialized, /FINDINGS: UNAVAILABLE/);
});

test('marks partial coverage and includes skip reasons', () => {
  const payload = buildTeamsAdaptiveCard({ repository: 'a/b', pullRequest, ciStatus: 'success', ai: baseAi({ coverage }), workflowUrl: 'https://github.com/a/b/actions/runs/1' });
  const serialized = text(payload);
  assert.match(serialized, /REVIEW PARTIAL/);
  assert.match(serialized, /4\/5 files reviewed/);
  assert.match(serialized, /dist\/app\.js/);
});

test('renders skipped review with deterministic next action', () => {
  const payload = buildTeamsAdaptiveCard({ repository: 'a/b', pullRequest, ciStatus: 'skipped', ai: { status: 'skipped', error: 'Fork pull request is not trusted.', coverage: {} }, workflowUrl: 'https://github.com/a/b/actions/runs/1' });
  const serialized = text(payload);
  assert.match(serialized, /REVIEW SKIPPED/);
  assert.match(serialized, /Fork pull request/);
  assert.doesNotMatch(serialized, /CRITICAL/);
});

test('handles missing metadata and invalid URLs without throwing', () => {
  const payload = buildTeamsAdaptiveCard({ repository: '', pullRequest: { number: 1, title: '', head: {} }, ciStatus: 'unknown', ai: { status: 'failed', error: 'malformed response', coverage: {} }, workflowUrl: 'javascript:alert(1)' });
  assert.equal(card(payload).actions, undefined);
  assert.doesNotMatch(text(payload), /javascript:/);
  assert.match(text(payload), /Unavailable/);
});

test('uses the PR files page when a finding has no valid line', () => {
  const payload = buildTeamsAdaptiveCard({ repository: 'a/b', pullRequest, ciStatus: 'success', ai: baseAi({ findings: [finding('high', 0)] }), workflowUrl: 'https://github.com/a/b/actions/runs/1' });
  assert.match(text(payload), /github\.com\/nmhieu0303\/CatCamera\/pull\/42\/files/);
});

test('redacts secrets and truncates long untrusted text', () => {
  const payload = buildTeamsAdaptiveCard({ repository: 'a/b', pullRequest: { ...pullRequest, title: 'x'.repeat(2000) }, ciStatus: 'success', ai: baseAi({ summary: 'AIzaSySECRET ' + 'y'.repeat(2000), findings: [finding('high', 1, 'sk-or-v1-secret') ] }), workflowUrl: 'https://github.com/a/b/actions/runs/1' });
  const serialized = text(payload);
  assert.doesNotMatch(serialized, /AIzaSySECRET|sk-or-v1-secret/);
  assert.ok(serialized.length < 12000);
});

test('reports webhook delivery failure without throwing', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('bad', { status: 500 });
  try {
    const result = await sendTeamsWebhook('https://example.test/webhook', { type: 'message' }, { retries: 0 });
    assert.equal(result.sent, false);
    assert.equal(result.status, 500);
    assert.match(result.error, /HTTP 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
