const MAX_FILES = 8;
const MAX_LINES_PER_FILE = 120;

function decodeContent(data) {
  if (!data || data.encoding !== 'base64' || typeof data.content !== 'string') return null;
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

export async function retrieveBoundedContext(client, owner, repo, sha, reviewedFiles) {
  const context = [];
  for (const file of reviewedFiles.slice(0, MAX_FILES)) {
    if (file.status === 'removed') continue;
    try {
      const data = await client.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${file.filename.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(sha)}`);
      const source = decodeContent(data);
      if (!source) continue;
      const lines = source.split('\n');
      const selected = new Set();
      for (const changed of file.changedLines) {
        for (let line = Math.max(1, changed - 15); line <= Math.min(lines.length, changed + 15); line += 1) selected.add(line);
      }
      const ordered = [...selected].sort((a, b) => a - b).slice(0, MAX_LINES_PER_FILE);
      context.push({ file: file.filename, lines: ordered.map(line => `${line}: ${lines[line - 1]}`).join('\n') });
    } catch {
      // Context is optional. The patch remains the source of truth.
    }
  }
  return context;
}
