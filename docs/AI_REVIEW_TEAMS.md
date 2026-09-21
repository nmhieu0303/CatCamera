# Microsoft Teams AI review notifications

The AI review workflow keeps the existing Teams Workflows/incoming webhook integration and sends one Adaptive Card 1.2 message after the review is calculated. The card contains metadata and review results only; it never includes source code, API keys, device credentials, encryption keys, or signed stream URLs.

## Configuration

Add `TEAMS_WEBHOOK_URL` as an Actions secret. The workflow passes the webhook URL to `scripts/ai-review/index.mjs`; delivery is retried for transient HTTP failures. A non-successful webhook response is reported as `teamsError` and does not change the AI result or CI result.

The card builder receives this normalized shape:

```json
{
  "repository": "nmhieu0303/CatCamera",
  "pullRequest": {
    "number": 42,
    "title": "Improve camera diagnostics",
    "html_url": "https://github.com/nmhieu0303/CatCamera/pull/42",
    "user": { "login": "reviewer" },
    "head": { "ref": "feature/diagnostics", "sha": "0123456789abcdef0123456789abcdef01234567" },
    "base": { "ref": "main" }
  },
  "ciStatus": "success",
  "workflowUrl": "https://github.com/nmhieu0303/CatCamera/actions/runs/123",
  "ai": {
    "status": "completed",
    "summary": "One actionable issue was found.",
    "findings": [{
      "severity": "high",
      "title": "Validate webhook URL",
      "file": "scripts/ai-review/index.mjs",
      "line": 120,
      "description": "The URL is accepted without checking its scheme.",
      "suggestion": "Allow HTTPS URLs only."
    }],
    "coverage": { "filesChanged": 3, "filesReviewed": 3, "filesSkipped": 0 }
  },
  "diffStats": { "filesChanged": 3, "additions": 48, "deletions": 9 }
}
```

All URLs are accepted only when they use HTTPS. Finding links point to the changed file and line when the PR head SHA and line are valid; otherwise they fall back to the PR files page. Text is bounded, newline-normalized, and redacted for common API-key prefixes before it is placed in the card.

## Card states

CI and AI are rendered independently, so a failed check does not turn a completed AI review into a failure.

| AI state | Card behavior | Next action |
| --- | --- | --- |
| `completed` with findings | Shows severity counts, summary, and up to three highest-severity findings, with a link to all files | Fix or verify critical/high findings first |
| `completed` with zero findings | Shows explicit zero counts and a clean summary | Human review is still required |
| `completed` with `coverage.partial` | Shows reviewed/changed percentage and skipped-file reasons | Inspect uncovered changes manually |
| `failed` | Shows `FINDINGS: UNAVAILABLE`; it does not display zero counts | Inspect workflow logs and rerun the review |
| `skipped`, `stale`, or `unavailable` | Shows `REVIEW SKIPPED` and the safe reason | Confirm provider/workflow configuration |
| `in_progress` or unknown | Shows that findings are unavailable | Wait for or rerun the workflow |

CI is mapped separately to `PASSED`, `FAILED`, `RUNNING`, `SKIPPED`, or `UNKNOWN`. The card always includes PR metadata, commit, diff statistics, coverage, deterministic next action, and safe navigation links when available.

## Additional examples

Clean result:

```json
{ "ciStatus": "success", "ai": { "status": "completed", "summary": "No issues reported by AI.", "findings": [], "coverage": { "filesChanged": 2, "filesReviewed": 2, "filesSkipped": 0 } } }
```

Failed provider:

```json
{ "ciStatus": "success", "ai": { "status": "failed", "error": "Provider request failed", "coverage": { "filesChanged": 2, "filesReviewed": 0, "filesSkipped": 2 } } }
```

Partial review:

```json
{ "ciStatus": "failure", "ai": { "status": "completed", "coverage": { "filesChanged": 4, "filesReviewed": 2, "filesSkipped": 2, "partial": true, "skipped": [{ "file": "bundle.js", "reason": "generated output" }] } } }
```

## Verification

`tests/ai-review/teams.test.mjs` validates card structure, state independence, severity ordering, partial coverage, invalid URL handling, redaction, and webhook failure handling. These tests validate the JSON payload and do not claim that a physical Teams tenant rendered the card. A live rendering check requires a configured `TEAMS_WEBHOOK_URL` and a real workflow run.
