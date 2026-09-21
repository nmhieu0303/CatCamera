import Fastify from 'fastify';
import { createHash, createHmac, randomUUID } from 'node:crypto';

const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.body', 'res.body'] } });
const { IMOU_APP_ID, IMOU_APP_SECRET, IMOU_REGION = 'sg', API_PORT = '3001' } = process.env;
const regions = { sg: 'https://openapi-sg.easy4ip.com', fk: 'https://openapi-fk.easy4ip.com', or: 'https://openapi-or.easy4ip.com' };
if (!IMOU_APP_ID || !IMOU_APP_SECRET || IMOU_APP_ID === 'replace_me' || IMOU_APP_SECRET === 'replace_me') {
  throw Error('Set IMOU_APP_ID and IMOU_APP_SECRET in .env');
}
if (!regions[IMOU_REGION]) throw Error('IMOU_REGION must be sg, fk or or');
const cameras = [1, 2].map(n => ({
  slot: n,
  name: `Camera ${n}`,
  deviceId: process.env[`CAMERA_${n}_ID`],
  channelId: process.env[`CAMERA_${n}_CHANNEL`] || '0',
}));
if (cameras.some(c => !c.deviceId || c.deviceId.startsWith('replace_'))) throw Error('Set CAMERA_1_ID and CAMERA_2_ID in .env');
let adminToken = null;
let adminExpires = 0;
const kitTokens = new Map();

async function imou(method, params) {
  const time = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  // Development Specification (current): SHA256(secret) as hex -> HMAC-SHA256 -> Base64.
  const password = createHash('sha256').update(IMOU_APP_SECRET).digest('hex');
  const sign = createHmac('sha256', password)
    .update(`time:${time},nonce:${nonce},appSecret:${IMOU_APP_SECRET}`).digest('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(`${regions[IMOU_REGION]}/openapi/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ system: { ver: '1.0', appId: IMOU_APP_ID, sign, time, nonce }, id: randomUUID(), params }),
    });
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw Error(`Imou HTTP ${response.status}`);
  const json = await response.json();
  if (String(json?.result?.code) !== '0') {
    const code = String(json?.result?.code ?? 'unknown');
    throw Error(`Imou API ${method} failed: ${code}`); // Do not log tokens/secrets or full vendor response.
  }
  return json.result.data;
}
async function getAdminToken() {
  if (adminToken && Date.now() < adminExpires) return adminToken;
  const data = await imou('accessToken', {});
  if (!data?.accessToken) throw Error('Imou did not return accessToken');
  adminToken = data.accessToken;
  const seconds = Number(data.expireTime) || 3600;
  adminExpires = Date.now() + Math.max(60, seconds - 300) * 1000;
  return adminToken;
}
app.get('/api/health', async () => ({ ok: true, sdk: 'Load official SDK files in public/imou-sdk/' }));
// Only preconfigured cameras are exposed. No arbitrary deviceId from browser.
app.get('/api/cameras', async () => cameras.map(({ slot, name }) => ({ slot, name })));
function textField(value, fallback = 'unknown') {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

function safeDeviceDiagnostic(camera, data) {
  const detail = Array.isArray(data?.deviceList) ? data.deviceList[0] : null;
  if (!detail) throw Error('Imou returned no device details');
  const encryptMode = textField(detail.encryptMode);
  const encryption = encryptMode === '0'
    ? {
      mode: 'default',
      label: 'Device default encryption',
      explanation: 'The device reports default encryption. Leave the SDK code blank first, as in the official demo; use a device password or custom key only if the camera requires one.',
    }
    : encryptMode === '1'
      ? {
        mode: 'user-defined',
        label: 'User-defined encryption',
        explanation: 'The device reports a user-defined audio/video encryption key. Enter that key from the device settings; do not guess it.',
      }
      : {
        mode: 'unknown',
        label: 'Encryption mode unavailable',
        explanation: 'The device did not return a recognized encryption mode.',
      };
  const channel = Array.isArray(detail.channelList)
    ? detail.channelList.find(item => String(item?.channelId) === String(camera.channelId)) || detail.channelList[0]
    : null;
  return {
    slot: camera.slot,
    name: camera.name,
    deviceModel: textField(detail.deviceModel),
    deviceStatus: textField(detail.deviceStatus),
    deviceAbility: textField(detail.deviceAbility, ''),
    encryptMode,
    encryption,
    channelStatus: textField(channel?.channelStatus),
    channelAbility: textField(channel?.channelAbility, ''),
  };
}

app.get('/api/cameras/:slot/diagnostic', async (req, reply) => {
  const slot = Number(req.params.slot);
  const camera = cameras.find(item => item.slot === slot);
  if (!camera) return reply.code(404).send({ error: 'Unknown camera' });
  try {
    const token = await getAdminToken();
    const data = await imou('listDeviceDetailsByIds', {
      token,
      deviceList: [{ deviceId: camera.deviceId, channelId: [String(camera.channelId)] }],
    });
    return safeDeviceDiagnostic(camera, data);
  } catch (error) {
    req.log.error({ err: error.message, slot }, 'Camera diagnostic request failed');
    return reply.code(502).send({ error: 'Camera diagnostic unavailable' });
  }
});

app.post('/api/cameras/:slot/kit-token', async (req, reply) => {
  const slot = Number(req.params.slot);
  const camera = cameras.find(c => c.slot === slot);
  if (!camera) return reply.code(404).send({ error: 'Unknown camera' });
  try {
    const cached = kitTokens.get(slot);
    if (cached && Date.now() < cached.until) return { ...cached.data, slot };
    let token = await getAdminToken();
    let data;
    try {
      data = await imou('getKitToken', { token, deviceId: camera.deviceId, channelId: camera.channelId, type: '1' });
    } catch (error) {
      // Refresh once for expired admin tokens; avoid retrying for other failures.
      if (!String(error.message).includes('TK1002')) throw error;
      adminToken = null;
      token = await getAdminToken();
      data = await imou('getKitToken', { token, deviceId: camera.deviceId, channelId: camera.channelId, type: '1' });
    }
    if (!data?.kitToken) throw Error('Imou did not return kitToken');
    const result = { deviceId: camera.deviceId, channelId: Number(camera.channelId), kitToken: data.kitToken };
    // Vendor kitToken lasts ~2h; cache for <=1h as recommended.
    kitTokens.set(slot, { data: result, until: Date.now() + Math.min(3600, Math.max(60, Number(data.expireTime || 7200) - 300)) * 1000 });
    return { ...result, slot };
  } catch (error) {
    req.log.error({ err: error.message, slot }, 'Camera token request failed');
    return reply.code(502).send({ error: error.message });
  }
});
// SECURITY: local PoC only. Add authentication, HTTPS, rate limits, origin checks, and authorization before cloud deployment.
await app.listen({ host: '127.0.0.1', port: Number(API_PORT) });
