const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|eot|wasm|zip|gz|pdf|mp4|mov|avi)$/i;
const LOCKFILES = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/i;
const SECRET_PATHS = /(?:^|\/)(?:\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx|jks))|(?:secret|credential|password|token)/i;
const SKIP_PATHS = /(?:^|\/)(?:node_modules|dist|build|coverage|public\/imou-sdk|vendor|generated)(?:\/|$)/i;

export const DEFAULT_LIMITS = {
  maxFiles: Number(process.env.AI_MAX_FILES || 100),
  maxPatchChars: Number(process.env.AI_MAX_PATCH_CHARS || 12000),
  maxTotalChars: Number(process.env.AI_MAX_TOTAL_CHARS || 60000),
};

export function parseUnifiedPatch(patch = '') {
  const changedLines = new Set();
  const lines = String(patch).split('\n');
  let newLine = 0;
  let oldLine = 0;
  for (const line of lines) {
    const header = line.match(/^@@ -(?<old>\d+)(?:,\d+)? \+(?<next>\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = Number(header.groups.old);
      newLine = Number(header.groups.next);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      changedLines.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return changedLines;
}

function skipReason(file) {
  const path = file.filename || '';
  if (BINARY_EXTENSIONS.test(path)) return 'binary-file';
  if (SECRET_PATHS.test(path)) return 'sensitive-file';
  if (LOCKFILES.test(path)) return 'dependency-lockfile';
  if (SKIP_PATHS.test(path)) return 'generated-vendor-or-bundled-asset';
  if (!file.patch) return 'missing-or-truncated-patch';
  return null;
}

export function collectReviewableFiles(files, limits = DEFAULT_LIMITS) {
  const reviewed = [];
  const skipped = [];
  let totalChars = 0;
  let incomplete = false;
  for (const [index, file] of files.entries()) {
    if (index >= limits.maxFiles) {
      skipped.push({ file: file.filename, reason: 'file-count-limit' });
      incomplete = true;
      continue;
    }
    const reason = skipReason(file);
    if (reason) {
      skipped.push({ file: file.filename, reason });
      if (reason === 'missing-or-truncated-patch') incomplete = true;
      continue;
    }
    if (file.patch.length > limits.maxPatchChars) {
      skipped.push({ file: file.filename, reason: 'per-file-patch-limit' });
      incomplete = true;
      continue;
    }
    if (totalChars + file.patch.length > limits.maxTotalChars) {
      skipped.push({ file: file.filename, reason: 'total-input-limit' });
      incomplete = true;
      continue;
    }
    totalChars += file.patch.length;
    reviewed.push({
      filename: file.filename,
      status: file.status,
      previousFilename: file.previous_filename || null,
      patch: file.patch,
      changedLines: [...parseUnifiedPatch(file.patch)].sort((a, b) => a - b),
    });
  }
  return {
    filesChanged: files.length,
    filesReviewed: reviewed.length,
    filesSkipped: skipped.length,
    skipped,
    reviewed,
    totalChars,
    partial: incomplete || skipped.length > 0,
  };
}

export function changedLinesMap(review) {
  return new Map(review.reviewed.map(file => [file.filename, new Set(file.changedLines)]));
}
