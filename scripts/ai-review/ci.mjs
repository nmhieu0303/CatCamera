const EMPTY_CI = { lint: 'not-run', types: 'not-run', backend: 'not-run', assets: 'not-run', tests: 'not-run', build: 'not-run' };

function stepResult(steps, name, optional = false) {
  const result = steps.get(name);
  if (!result) return 'not-run';
  return optional && result === 'skipped' ? 'not-configured' : result;
}

/** Convert the trusted static workflow's job steps into report-safe states. */
export function summarizeCiJobs(jobs = []) {
  const source = jobs.find(job => job?.name === 'Source checks');
  if (!source) return { ...EMPTY_CI };
  const steps = new Map((source.steps || []).map(step => [step.name, step.conclusion || 'not-run']));
  return {
    lint: stepResult(steps, 'ESLint (if configured)', true),
    types: stepResult(steps, 'TypeScript type check'),
    backend: stepResult(steps, 'Backend syntax check'),
    assets: stepResult(steps, 'Verify Imou SDK assets'),
    tests: stepResult(steps, 'Tests (if configured)', true),
    build: stepResult(steps, 'Frontend and backend build'),
  };
}
