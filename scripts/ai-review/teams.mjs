import { cleanText, findingFingerprint } from './schema.mjs';
import { findingCounts } from './report.mjs';

export function buildTeamsAdaptiveCard({ repository, pullRequest, ciStatus, ai, workflowUrl }) {
  const counts = findingCounts(ai.findings || []);
  const status = ai.status === 'completed' ? 'AI completed' : ai.status === 'unavailable' ? 'AI unavailable' : ai.status === 'stale' ? 'AI stale' : 'AI failed';
  const summary = cleanText(ai.summary || ai.error || 'No AI summary available.', 700);
  const card = {
    '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.2',
    body: [
      { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: `${repository} · PR #${pullRequest.number}` },
      { type: 'TextBlock', text: cleanText(pullRequest.title, 180), wrap: true, spacing: 'Small' },
      { type: 'FactSet', facts: [
        { title: 'Author', value: cleanText(pullRequest.user?.login || 'unknown', 80) },
        { title: 'Commit', value: pullRequest.head.sha.slice(0, 12) },
        { title: 'CI', value: ciStatus },
        { title: 'AI', value: status },
        { title: 'Findings', value: `C ${counts.critical} · H ${counts.high} · M ${counts.medium} · L ${counts.low}` },
        { title: 'Coverage', value: `${ai.coverage?.filesReviewed || 0}/${ai.coverage?.filesChanged || 0} files${ai.coverage?.partial ? ' (partial)' : ''}` },
      ] },
      { type: 'TextBlock', text: summary, wrap: true, spacing: 'Medium' },
    ],
    actions: [
      { type: 'Action.OpenUrl', title: 'Open pull request', url: pullRequest.html_url },
      { type: 'Action.OpenUrl', title: 'Open workflow', url: workflowUrl },
    ],
  };
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: card }],
  };
}

export async function sendTeamsWebhook(url, payload, { retries = 2 } = {}) {
  if (!url) return { sent: false, skipped: true };
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      if (response.ok || response.status === 202) return { sent: true, status: response.status };
      if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt >= retries) return { sent: false, status: response.status };
      await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
    } catch {
      if (attempt >= retries) return { sent: false, status: 0 };
    }
  }
  return { sent: false, status: 0 };
}
