import { cleanText } from './schema.mjs';
import { findingCounts } from './report.mjs';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITY_COLOR = { critical: 'Attention', high: 'Warning', medium: 'Warning', low: 'Accent' };

function display(value, max = 500) {
  return cleanText(value ?? '', max)
    .replace(/(?:sk-or-v1-|sk-|rk-|AIza)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

function available(value) {
  const text = display(value, 200);
  return text || 'Unavailable';
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function pullRequestFilesUrl(pullRequest) {
  const url = safeUrl(pullRequest?.html_url);
  return url ? `${url.replace(/\/$/, '')}/files` : null;
}

function findingUrl(pullRequest, finding) {
  const pullUrl = safeUrl(pullRequest?.html_url);
  if (!pullUrl) return null;
  const file = display(finding?.file, 300);
  const line = Number(finding?.line);
  const sha = String(pullRequest?.head?.sha || '');
  if (!file || !/^[a-f0-9]{7,64}$/i.test(sha) || !Number.isInteger(line) || line < 1) return `${pullUrl.replace(/\/$/, '')}/files`;
  const repoPath = new URL(pullUrl).pathname.replace(/\/pull\/\d+(?:\/.*)?$/, '');
  const encodedPath = file.split('/').map(encodeURIComponent).join('/');
  return `${new URL(pullUrl).origin}${repoPath}/blob/${sha}/${encodedPath}#L${line}`;
}

function ciState(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'success' || normalized === 'passed' || normalized === 'completed') return { label: 'PASSED', color: 'Good' };
  if (normalized === 'failure' || normalized === 'failed' || normalized === 'cancelled') return { label: 'FAILED', color: 'Attention' };
  if (normalized === 'queued' || normalized === 'in_progress' || normalized === 'running') return { label: 'RUNNING', color: 'Warning' };
  if (normalized === 'skipped' || normalized === 'not-run' || normalized === 'not-configured') return { label: 'SKIPPED', color: 'Default' };
  return { label: 'UNKNOWN', color: 'Default' };
}

function aiState(ai = {}) {
  if (ai.status === 'completed') return ai.coverage?.partial ? { label: 'REVIEW PARTIAL', color: 'Warning', completed: true } : { label: 'REVIEW COMPLETED', color: 'Good', completed: true };
  if (ai.status === 'partial') return { label: 'REVIEW PARTIAL', color: 'Warning', completed: true };
  if (ai.status === 'failed') return { label: 'REVIEW FAILED', color: 'Attention', completed: false };
  if (ai.status === 'in_progress' || ai.status === 'running') return { label: 'REVIEW IN PROGRESS', color: 'Warning', completed: false };
  if (ai.status === 'skipped' || ai.status === 'unavailable' || ai.status === 'stale') return { label: 'REVIEW SKIPPED', color: 'Default', completed: false };
  return { label: 'REVIEW FAILED', color: 'Attention', completed: false };
}

function statusBlock(label, state) {
  return {
    type: 'Container',
    style: 'emphasis',
    items: [
      { type: 'TextBlock', text: label, size: 'Small', weight: 'Bolder', spacing: 'None' },
      { type: 'TextBlock', text: state.label, color: state.color, weight: 'Bolder', size: 'Medium', spacing: 'Small' },
    ],
  };
}

function coverageText(coverage = {}) {
  const changed = Number(coverage.filesChanged);
  const reviewed = Number(coverage.filesReviewed);
  const skipped = Number(coverage.filesSkipped || 0);
  if (!Number.isFinite(changed) || !Number.isFinite(reviewed)) return 'Coverage: Unavailable';
  const percent = changed > 0 ? Math.round((reviewed / changed) * 100) : 0;
  return `${reviewed}/${changed} files reviewed (${percent}%)${skipped ? ` · ${skipped} skipped` : ''}${coverage.partial ? ' · partial' : ''}`;
}

function reviewerAction(state, ai, counts) {
  if (state.label === 'REVIEW FAILED') return 'AI review did not complete. Inspect the workflow logs and rerun the review.';
  if (state.label === 'REVIEW SKIPPED') return display(ai.error || 'AI review was skipped. Confirm the workflow configuration.', 300);
  if (state.label === 'REVIEW PARTIAL') return 'AI reviewed only part of this PR. Inspect uncovered changes manually.';
  if (counts.critical || counts.high) return 'Review the Critical and High severity issues and verify the proposed fixes.';
  if (counts.medium || counts.low) return 'Review the reported findings and verify the proposed fixes.';
  return 'No issues reported by AI. Human review is still required.';
}

function topFindingBlocks(findings, pullRequest) {
  const ranked = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  return ranked.slice(0, 3).map(finding => {
    const severity = String(finding.severity || 'low').toLowerCase();
    const line = Number(finding.line);
    const location = [display(finding.file, 240), Number.isInteger(line) && line > 0 ? `Line ${line}` : 'File location'].join(' · ');
    const items = [
      { type: 'TextBlock', text: `${severity.toUpperCase()} — ${display(finding.title, 180)}`, color: SEVERITY_COLOR[severity] || 'Default', weight: 'Bolder', wrap: true, spacing: 'None' },
      { type: 'TextBlock', text: location, isSubtle: true, size: 'Small', wrap: true, spacing: 'Small' },
      { type: 'TextBlock', text: display(finding.description, 420), wrap: true, spacing: 'Small' },
    ];
    if (finding.suggestion) items.push({ type: 'TextBlock', text: `Suggested fix: ${display(finding.suggestion, 320)}`, wrap: true, spacing: 'Small' });
    const url = findingUrl(pullRequest, finding);
    if (url) items.push({ type: 'ActionSet', actions: [{ type: 'Action.OpenUrl', title: 'View code', url }] });
    return { type: 'Container', style: 'emphasis', spacing: 'Small', items };
  });
}

export function buildTeamsAdaptiveCard({ repository, pullRequest, ciStatus, ai = {}, workflowUrl, diffStats = {} }) {
  const state = aiState(ai);
  const ci = ciState(ciStatus);
  const counts = state.completed ? findingCounts(ai.findings || []) : null;
  const changed = Number.isFinite(Number(diffStats.filesChanged)) ? Number(diffStats.filesChanged) : ai.coverage?.filesChanged;
  const findings = state.completed ? (ai.findings || []) : [];
  const actions = [];
  const prUrl = safeUrl(pullRequest?.html_url);
  const fullReviewUrl = pullRequestFilesUrl(pullRequest);
  const runUrl = safeUrl(workflowUrl);
  if (prUrl) actions.push({ type: 'Action.OpenUrl', title: 'Open pull request', url: prUrl });
  if (fullReviewUrl) actions.push({ type: 'Action.OpenUrl', title: 'View full AI review', url: fullReviewUrl });
  if (runUrl) actions.push({ type: 'Action.OpenUrl', title: 'View workflow', url: runUrl });

  const body = [
    { type: 'ColumnSet', columns: [
      { type: 'Column', width: 'stretch', items: [
        { type: 'TextBlock', text: 'AI CODE REVIEW', size: 'Large', weight: 'Bolder', color: 'Accent' },
        { type: 'TextBlock', text: available(repository), size: 'Small', isSubtle: true, spacing: 'Small' },
        { type: 'TextBlock', text: `PR #${Number(pullRequest?.number) || '—'} — ${available(pullRequest?.title)}`, wrap: true, spacing: 'Small' },
      ] },
      { type: 'Column', width: 'auto', items: [{ type: 'TextBlock', text: state.label, color: state.color, weight: 'Bolder', wrap: true, horizontalAlignment: 'Right' }] },
    ] },
    { type: 'FactSet', spacing: 'Medium', facts: [
      { title: 'Author', value: available(pullRequest?.user?.login) },
      { title: 'Branch', value: `${available(pullRequest?.head?.ref)} → ${available(pullRequest?.base?.ref)}` },
      { title: 'Commit', value: available(pullRequest?.head?.sha ? String(pullRequest.head.sha).slice(0, 12) : '') },
      { title: 'Files', value: Number.isFinite(Number(changed)) ? String(changed) : 'Unavailable' },
      { title: 'Added / deleted', value: `${Number.isFinite(Number(diffStats.additions)) ? diffStats.additions : '—'} / ${Number.isFinite(Number(diffStats.deletions)) ? diffStats.deletions : '—'}` },
    ] },
    { type: 'ColumnSet', spacing: 'Medium', columns: [
      { type: 'Column', width: 'stretch', items: [statusBlock('CI STATUS', ci)] },
      { type: 'Column', width: 'stretch', items: [statusBlock('AI REVIEW STATUS', state)] },
    ] },
  ];

  if (state.completed) {
    body.push({ type: 'TextBlock', text: 'FINDINGS SUMMARY', weight: 'Bolder', spacing: 'Medium' });
    body.push({ type: 'ColumnSet', columns: SEVERITY_ORDER.map(level => ({ type: 'Column', width: 'stretch', items: [
      { type: 'TextBlock', text: level.toUpperCase(), size: 'Small', isSubtle: true, horizontalAlignment: 'Center' },
      { type: 'TextBlock', text: String(counts[level]), size: 'Medium', weight: 'Bolder', color: SEVERITY_COLOR[level], horizontalAlignment: 'Center', spacing: 'None' },
    ] })) });
    body.push({ type: 'TextBlock', text: display(ai.summary || (findings.length ? 'AI identified actionable findings.' : 'No issues reported by AI. Human review is still required.'), 700), wrap: true, spacing: 'Medium' });
    if (findings.length) {
      body.push({ type: 'TextBlock', text: 'TOP FINDINGS', weight: 'Bolder', spacing: 'Medium' });
      body.push(...topFindingBlocks(findings, pullRequest));
      if (findings.length > 3) body.push({ type: 'TextBlock', text: `View all ${findings.length} findings on GitHub.`, isSubtle: true, wrap: true, spacing: 'Small' });
    }
  } else {
    body.push({ type: 'TextBlock', text: 'FINDINGS: UNAVAILABLE', weight: 'Bolder', color: state.color, spacing: 'Medium' });
    body.push({ type: 'TextBlock', text: display(ai.error || 'AI review did not complete.', 500), wrap: true, spacing: 'Small' });
  }

  body.push({ type: 'TextBlock', text: 'REVIEW COVERAGE', weight: 'Bolder', spacing: 'Medium' });
  body.push({ type: 'TextBlock', text: coverageText(ai.coverage), wrap: true, spacing: 'Small' });
  if (ai.coverage?.skipped?.length) body.push({ type: 'TextBlock', text: `Skipped: ${ai.coverage.skipped.slice(0, 3).map(item => `${display(item.file, 120)} (${display(item.reason, 80)})`).join(', ')}`, wrap: true, isSubtle: true, size: 'Small', spacing: 'Small' });
  body.push({ type: 'TextBlock', text: 'NEXT ACTION', weight: 'Bolder', spacing: 'Medium' });
  body.push({ type: 'TextBlock', text: reviewerAction(state, ai, counts || { critical: 0, high: 0, medium: 0, low: 0 }), wrap: true, spacing: 'Small' });

  return { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: {
    '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.2', body, ...(actions.length ? { actions } : {}),
  } }] };
}

export async function sendTeamsWebhook(url, payload, { retries = 2 } = {}) {
  if (!url) return { sent: false, skipped: true };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (response.ok || response.status === 202) return { sent: true, status: response.status };
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt >= retries) return { sent: false, status: response.status, error: `Teams webhook returned HTTP ${response.status}` };
      await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
    } catch {
      if (attempt >= retries) return { sent: false, status: 0, error: 'Teams webhook request failed' };
    }
  }
  return { sent: false, status: 0, error: 'Teams webhook request failed' };
}
