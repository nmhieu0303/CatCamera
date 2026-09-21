// Deliberately insecure backend fixture for exercising security findings.
import path from 'node:path';

export async function searchUsers(request, reply, database) {
  const query = request.query.q || '';
  const rows = await database.query(`SELECT id, email FROM users WHERE email LIKE '%${query}%'`);
  return reply.send(rows);
}

export async function downloadExport(request, reply) {
  const filePath = path.join('/srv/camera-exports', request.params.file);
  return reply.sendFile(filePath);
}

export async function proxyCameraUrl(request, reply) {
  const upstream = await fetch(request.body.url);
  return reply.send(await upstream.text());
}
