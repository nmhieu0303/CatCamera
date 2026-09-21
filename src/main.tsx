import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type ImouPlayer = {
  play(): void; pause(): void; start(): void; destroy(): void; fullScreen(): void;
};
type PlayerOptions = {
  id: string; width: number; height: number; deviceId: string; channelId: number;
  token: string; type: number; streamId: number; WasmLibPath: string; code?: string;
  muted?: boolean; controls?: boolean;
  log_js?: boolean; log_c?: boolean; dpr?: number;
  handleError?: (error: unknown) => void;
  handleCallBack?: (event: unknown) => void;
};
declare global { interface Window { imouPlayer?: new (config: PlayerOptions) => ImouPlayer; } }
type Camera = { slot: number; name: string };
type Kit = { slot: number; deviceId: string; channelId: number; kitToken: string };
type Diagnostic = {
  slot: number;
  name: string;
  deviceModel: string;
  deviceStatus: string;
  deviceAbility: string;
  encryptMode: string;
  encryption: { mode: string; label: string; explanation: string };
  channelStatus: string;
  channelAbility: string;
};

const DEBUG_IMOU = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_DEBUG_IMOU === 'true';

function redactDebug(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/https?:\/\/\S+/gi, '[redacted-url]')
      .replace(/\b(?:Kt|At)_[A-Za-z0-9_-]+\b/g, '[redacted-token]')
      .replace(/[A-Za-z0-9+/]{40,}/g, '[redacted-value]');
  }
  if (Array.isArray(value)) return value.map(redactDebug);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDebug(entry)]));
  }
  return value;
}

function debugImou(camera: number, message: string, details?: Record<string, unknown>) {
  if (DEBUG_IMOU) console.debug(`[Imou camera ${camera}] ${message}`, redactDebug(details ?? ''));
}

function sdkErrorDetails(error: unknown) {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    return {
      code: String(value.errCode ?? value.errorCode ?? 'unknown'),
      message: String(value.errMsg ?? value.description ?? value.message ?? 'Unknown SDK error'),
    };
  }
  return { code: 'unknown', message: String(error || 'Unknown SDK error') };
}

function sdkErrorStatus(cameraName: string, error: unknown) {
  const { code, message } = sdkErrorDetails(error);
  const action = code === '1001'
    ? 'Verify the device encryption key and reconnect.'
    : code === '1002'
      ? 'Check that the camera is online and try again.'
      : 'Check the camera connection and try again.';
  return `${cameraName}: ${message} (code ${code}). ${action}`;
}

function CameraPanel({ camera }: { camera: Camera }) {
  const mountId = `imou-camera-${camera.slot}`;
  const player = useRef<ImouPlayer | null>(null);
  const [status, setStatus] = useState('Chưa kết nối');
  const [streamId, setStreamId] = useState(0);
  const [code, setCode] = useState('');
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const playerSequence = useRef(0);
  const activePlayerSequence = useRef<number | null>(null);

  const destroyPlayer = () => {
    const current = player.current;
    player.current = null;
    if (current) debugImou(camera.slot, 'destroying player', { instanceId: activePlayerSequence.current });
    activePlayerSequence.current = null;
    try { current?.destroy(); } catch { /* SDK cleanup is best effort */ }
    document.getElementById(mountId)?.replaceChildren();
  };

  const stop = () => {
    generation.current += 1;
    requestAbort.current?.abort();
    requestAbort.current = null;
    destroyPlayer();
    if (mounted.current) {
      setConnected(false);
      setConnecting(false);
    }
    debugImou(camera.slot, 'player disconnected');
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      requestAbort.current?.abort();
      destroyPlayer();
    };
  }, []);

  const connect = async () => {
    if (busy.current) return;
    const attempt = ++generation.current;
    const abort = new AbortController();
    requestAbort.current = abort;
    busy.current = true;
    setConnecting(true);
    destroyPlayer();
    setConnected(false);
    setStatus('Đang xin kitToken...');
    debugImou(camera.slot, 'requesting kitToken');
    try {
      if (!window.imouPlayer) throw Error('Thiếu SDK: public/imou-sdk/imou-player.js');
      const response = await fetch(`/api/cameras/${camera.slot}/kit-token`, { method: 'POST', signal: abort.signal });
      const data = await response.json() as Kit & { error?: string };
      if (!response.ok) throw Error(data.error || `API lỗi ${response.status}`);
      if (attempt !== generation.current || !mounted.current) return;
      debugImou(camera.slot, 'kitToken request completed', { httpStatus: response.status });
      setStatus('Đang khởi tạo player...');
      const element = document.getElementById(mountId);
      if (!element) throw Error('Không thấy khung player');
      const enteredCode = code.trim();
      // Match the official demo: an empty code lets the SDK apply its own
      // default-device handling. Only pass a value when the user entered one.
      const encryptionCode = enteredCode || undefined;
      const codeSource = enteredCode ? 'entered' : 'sdk-default';
      let playerFailed = false;
      const newPlayer = new window.imouPlayer({
        id: mountId, width: Math.max(320, Math.floor(element.clientWidth)), height: Math.max(210, Math.floor(element.clientWidth * 9 / 16)),
        deviceId: data.deviceId, channelId: data.channelId, token: data.kitToken,
        type: 1, streamId, muted: true, controls: true,
        WasmLibPath: '/imou-sdk/',
        code: encryptionCode,
        dpr: window.devicePixelRatio || 1,
        // Keep vendor logger output disabled: the SDK may include stream
        // details in its internal diagnostics. Our debug logger is redacted.
        log_js: false,
        log_c: false,
        handleError: (error) => {
          playerFailed = true;
          const details = sdkErrorDetails(error);
          debugImou(camera.slot, 'SDK error', { code: details.code, message: details.message });
          if (mounted.current && attempt === generation.current) {
            setConnected(false);
            setConnecting(false);
            setStatus(sdkErrorStatus(camera.name, error));
          }
        },
        handleCallBack: (event) => {
          const eventType = typeof event === 'object' && event !== null && 'type' in event
            ? String((event as { type: unknown }).type) : String(event);
          debugImou(camera.slot, 'SDK event', { type: eventType });
          if (eventType === 'playStart' && mounted.current && attempt === generation.current) setStatus('Đang phát');
        },
      });
      if (attempt !== generation.current || !mounted.current) {
        try { newPlayer.destroy(); } catch { /* stale player cleanup is best effort */ }
        return;
      }
      player.current = newPlayer;
      const instanceId = ++playerSequence.current;
      activePlayerSequence.current = instanceId;
      debugImou(camera.slot, 'created player', {
        instanceId,
        codePresent: Boolean(encryptionCode),
        codeLength: encryptionCode?.length ?? 0,
        codeSource,
      });
      if (playerFailed) return;
      setConnected(true);
      setStatus('Đã tạo player; chờ hình ảnh');
      // The official SDK defaults autoplay=true; calling play() here would race it.
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (attempt !== generation.current || !mounted.current) return;
      const message = error instanceof Error ? error.message : 'Không thể kết nối';
      debugImou(camera.slot, 'connection failed', { message });
      setStatus(`${camera.name}: ${message}`);
    } finally {
      if (attempt === generation.current) {
        busy.current = false;
        requestAbort.current = null;
        if (mounted.current) setConnecting(false);
      }
    }
  };
  const runDiagnostic = async () => {
    if (diagnosticBusy) return;
    setDiagnosticBusy(true);
    try {
      const response = await fetch(`/api/cameras/${camera.slot}/diagnostic`);
      const data = await response.json() as Diagnostic & { error?: string };
      if (!response.ok) throw Error(data.error || `API lỗi ${response.status}`);
      if (mounted.current) setDiagnostic(data);
    } catch (error) {
      if (mounted.current) setStatus(`${camera.name}: ${error instanceof Error ? error.message : 'Không thể chẩn đoán'}`);
    } finally {
      if (mounted.current) setDiagnosticBusy(false);
    }
  };
  return <section className="camera">
    <header><div><strong>{camera.name}</strong><small>Imou official Web SDK · Channel mặc định 0</small></div><span className={connected ? 'badge online' : 'badge'}>{connected ? 'PLAYER READY' : 'OFFLINE'}</span></header>
    <div className="viewport"><div id={mountId} className="player" /></div>
    <form className="settings" onSubmit={e => e.preventDefault()}><label>Chất lượng <select value={streamId} disabled={connected || connecting} onChange={e => setStreamId(Number(e.target.value))}><option value={0}>HD</option><option value={1}>SD</option></select></label>
      <label className="key">Mã giải mã (nếu cần) <input type="password" autoComplete="off" value={code} disabled={connected} onChange={e => setCode(e.target.value)} placeholder="Để trống nếu không đặt pass" /></label></form>
    <div className="diagnostic"><button disabled={diagnosticBusy} onClick={runDiagnostic}>{diagnosticBusy ? 'Đang chẩn đoán...' : 'Chẩn đoán thiết bị'}</button>{diagnostic && <p><strong>{diagnostic.encryption.label}</strong> · Model {diagnostic.deviceModel} · Trạng thái {diagnostic.deviceStatus}<br />{diagnostic.encryption.explanation}<br /><small>Capabilities: {diagnostic.deviceAbility || 'không có dữ liệu'}</small></p>}</div>
    <div className="actions"><button disabled={connected || connecting} onClick={connect}>▶ {connecting ? 'Đang kết nối...' : 'Kết nối'}</button><button disabled={!connected} onClick={() => { player.current?.pause(); setStatus('Đã tạm dừng'); }}>Tạm dừng</button><button disabled={!connected} onClick={() => { player.current?.start(); setStatus('Đang tiếp tục'); }}>Tiếp tục</button><button disabled={!connected} onClick={() => player.current?.fullScreen()}>Toàn màn hình</button><button disabled={!connected && !connecting} className="danger" onClick={() => { stop(); setStatus('Đã ngắt'); }}>Ngắt</button></div>
    <p className="status">{status}</p>
  </section>;
}
function App() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { fetch('/api/cameras').then(async r => { if (!r.ok) throw Error(`API lỗi ${r.status}`); return r.json(); }).then(setCameras).catch(e => setError(e.message)); }, []);
  return <main><div className="top"><div><div className="eyebrow">PRIVATE CAMERA LAB</div><h1>Imou · Dual Camera</h1><p>Xem đồng thời 2 camera bằng SDK chính thức. Chưa triển khai AI hoặc lưu video.</p></div><div className="pill">Local PoC · localhost only</div></div>
    {error ? <p className="error">{error} — kiểm tra API đang chạy ở cổng 3001.</p> : <div className="grid">{cameras.map(c => <CameraPanel key={c.slot} camera={c}/>)}</div>}
    <footer>Không đưa trang này lên Internet khi chưa bổ sung login, HTTPS và kiểm soát quyền. Mã giải mã chỉ nhập trên máy của bạn.</footer></main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
