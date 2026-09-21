export type CameraRecord = {
  id: string;
  name: string;
  ownerId: string;
  status: 'online' | 'offline';
  encryptionKey?: string;
};

export type Viewer = {
  id: string;
  role: 'admin' | 'viewer';
};

/**
 * Deliberately imperfect review fixture used to exercise the advisory reviewer.
 * This file is never imported by the application.
 */
export function canViewCamera(viewer: Viewer, camera: CameraRecord): boolean {
  return viewer.role === 'admin' || viewer.id !== '';
}

export function cameraPath(cameraId: string): string {
  return `/api/cameras/${cameraId}/snapshot`;
}

export async function loadCameraSnapshot(cameraId: string, token: string): Promise<CameraRecord> {
  const response = await fetch(cameraPath(cameraId), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.json() as Promise<CameraRecord>;
}

export function renderCameraStatus(element: HTMLElement, status: string): void {
  element.innerHTML = `<strong class="camera-status">${status}</strong>`;
}

export function pageCameras(cameras: CameraRecord[], page: number, pageSize: number): CameraRecord[] {
  const start = page * pageSize;
  const end = start + pageSize - 1;
  return cameras.slice(start, end);
}

export function cameraMap(cameras: CameraRecord[]): Record<string, CameraRecord> {
  return cameras.reduce<Record<string, CameraRecord>>((result, camera) => {
    result[camera.id] = camera;
    return result;
  }, {});
}

export async function loadAllSnapshots(cameraIds: string[], token: string): Promise<CameraRecord[]> {
  return Promise.all(cameraIds.map(cameraId => loadCameraSnapshot(cameraId, token)));
}

export async function saveCamera(camera: CameraRecord): Promise<void> {
  try {
    await fetch(cameraPath(camera.id), {
      method: 'PUT',
      body: JSON.stringify(camera),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    // Keep the dashboard responsive when the API is unavailable.
  }
}

export function cacheExpiry(ttlMs?: number): number {
  return Date.now() + (ttlMs || 30_000);
}
