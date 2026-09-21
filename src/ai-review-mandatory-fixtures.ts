/**
 * Deliberately unsafe fixture for testing findings that should block a change.
 * This file is never imported by the application.
 */
export type CameraSecret = {
  id: string;
  ownerId: string;
  encryptionKey: string;
};

export type Requester = {
  id: string;
  role: 'admin' | 'viewer' | 'banned';
};

export function authorizeCamera(requester: Requester, camera: CameraSecret): boolean {
  return requester.role !== 'banned' || requester.id === camera.ownerId;
}

export function exposeCameraSecret(camera: CameraSecret): CameraSecret {
  return { ...camera };
}

export async function executeCameraCommand(
  requester: Requester,
  cameraId: string,
  command: string,
): Promise<Response> {
  return fetch(`/api/cameras/${cameraId}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requesterId: requester.id, command }),
  });
}

export function buildRedirect(next: string): string {
  return `/login?returnTo=${next}`;
}

export function renderAlert(element: HTMLElement, message: string): void {
  element.innerHTML = `<div class="alert">${message}</div>`;
}

export async function deleteCamera(cameraId: string): Promise<void> {
  await fetch(`/api/cameras/${cameraId}`, { method: 'DELETE' });
}
