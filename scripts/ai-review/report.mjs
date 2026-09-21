import { cleanText, findingFingerprint } from './schema.mjs';

export const SUMMARY_MARKER = '<!-- catcamera-pr-review -->';

function markdownText(value, max = 1200) {
  return cleanText(value, max).replace(/[\\`*_{}[\]()<>#+.!|>-]/g, '\\$&');
}

export function statusLabel(value, optional = false) {
  if (value === 'success') return '✅ passed';
  if (value === 'failure') return '❌ failed';
  if (value === 'skipped') return '➖ skipped';
  if (value === 'not-configured') return optional ? '⚪ not configured' : '➖ not run';
  return `⚠️ ${value || 'not run'}`;
}

export function findingCounts(findings = []) {
  return Object.fromEntries(['critical', 'high', 'medium', 'low'].map(level => [level, findings.filter(item => item.severity === level).length]));
}

export function findingComment(finding) {
  const fingerprint = finding.fingerprint || findingFingerprint(finding);
  return `<!-- catcamera-finding:${fingerprint} -->\n**${markdownText(finding.title, 180)}** (${finding.severity}, ${Math.round(finding.confidence * 100)}% confidence)\n\n${markdownText(finding.description)}\n\n**Evidence:** ${markdownText(finding.evidence)}\n\n**Suggested fix:** ${markdownText(finding.suggestion)}`;
}

export function buildSummaryBody({ pullRequest, ci = {}, ai = {}, runUrl }) {
  const counts = findingCounts(ai.findings || []);
  const coverage = ai.coverage || { filesChanged: 0, filesReviewed: 0, filesSkipped: 0, partial: true, skipped: [] };
  const aiStatus = ai.status === 'completed' ? '✅ completed' : ai.status === 'unavailable' ? '⚪ unavailable' : ai.status === 'stale' ? '⚠️ stale — not published' : '❌ failed';
  const skipped = coverage.skipped?.length
    ? coverage.skipped.slice(0, 20).map(item => `  - \`${cleanText(item.file, 180)}\`: ${cleanText(item.reason, 120)}`).join('\n')
    : '  - None';
  const body = [
    SUMMARY_MARKER,
    '## CatCamera PR review',
    '',
    `**PR:** [#${pullRequest.number} ${markdownText(pullRequest.title, 180)}](${pullRequest.html_url})`,
    `**Commit:** \`${pullRequest.head.sha}\``,
    '',
    '### CI results',
    ...Object.entries({
      ESLint: ci.lint,
      TypeScript: ci.types,
      'Backend syntax': ci.backend,
      'SDK assets': ci.assets,
      Tests: ci.tests,
      Build: ci.build,
    }).map(([name, value]) => `- **${name}:** ${statusLabel(value, name === 'ESLint' || name === 'Tests')}`),
    '',
    `### AI review: ${aiStatus}`,
    ai.error ? `- **Error:** ${markdownText(ai.error, 500)}` : `- **Summary:** ${markdownText(ai.summary || 'No summary was returned.', 2000)}`,
    `- **Findings:** critical ${counts.critical}, high ${counts.high}, medium ${counts.medium}, low ${counts.low}`,
    `- **Coverage:** ${coverage.filesReviewed}/${coverage.filesChanged} files reviewed; ${coverage.filesSkipped} skipped; ${coverage.partial ? 'partial' : 'complete'}`,
    '',
    '### Skipped files',
    skipped,
    '',
    `[View workflow run](${runUrl}) · [Open pull request](${pullRequest.html_url})`,
  ];
  return body.join('\n');
}
