export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const CATEGORIES = ['correctness', 'react', 'typescript', 'async', 'security', 'performance', 'reliability'];

export const reviewResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'line', 'severity', 'category', 'title', 'description', 'evidence', 'suggestion', 'confidence'],
        properties: {
          file: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          severity: { type: 'string', enum: SEVERITIES },
          category: { type: 'string', enum: CATEGORIES },
          title: { type: 'string' },
          description: { type: 'string' },
          evidence: { type: 'string' },
          suggestion: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function cleanText(value, max = 1200) {
  return String(value ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);
}

export function findingFingerprint(finding) {
  const normalized = [finding.file, finding.category, finding.line, finding.title, finding.description]
    .map(value => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim())
    .join('|');
  let hash = 2166136261;
  for (const char of normalized) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function validateReview(payload, { reviewableFiles = new Set(), changedLinesByFile = new Map() } = {}) {
  let value = payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return { ok: false, error: 'AI returned invalid JSON', findings: [], rejected: 0 }; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.summary !== 'string' || !Array.isArray(value.findings)) {
    return { ok: false, error: 'AI response does not match the top-level schema', findings: [], rejected: 0 };
  }

  const findings = [];
  let rejected = 0;
  const seen = new Set();
  for (const candidate of value.findings.slice(0, 20)) {
    if (!candidate || typeof candidate !== 'object') { rejected += 1; continue; }
    const file = cleanText(candidate.file, 300);
    const line = Number(candidate.line);
    const severity = String(candidate.severity);
    const category = String(candidate.category);
    if (!reviewableFiles.has(file) || !Number.isInteger(line) || line < 1 || !SEVERITIES.includes(severity) || !CATEGORIES.includes(category)) {
      rejected += 1;
      continue;
    }
    const changedLines = changedLinesByFile.get(file) || new Set();
    if (!changedLines.has(line)) { rejected += 1; continue; }
    const finding = {
      file,
      line,
      severity,
      category,
      title: cleanText(candidate.title, 180),
      description: cleanText(candidate.description),
      evidence: cleanText(candidate.evidence),
      suggestion: cleanText(candidate.suggestion),
      confidence: Math.max(0, Math.min(1, Number(candidate.confidence))),
    };
    if (!finding.title || !finding.description || !finding.evidence || !finding.suggestion || !Number.isFinite(finding.confidence)) {
      rejected += 1;
      continue;
    }
    const fingerprint = findingFingerprint(finding);
    if (seen.has(fingerprint)) { rejected += 1; continue; }
    seen.add(fingerprint);
    findings.push({ ...finding, fingerprint });
  }
  return {
    ok: true,
    summary: cleanText(value.summary, 3000),
    findings,
    rejected,
  };
}
