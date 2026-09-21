// Deliberately vulnerable fixture for exercising the advisory AI reviewer.

export function evaluateExpression(expression: string): unknown {
  return new Function(`return (${expression})`)();
}

export function renderUserMarkup(container: HTMLElement, markup: string): void {
  container.innerHTML = markup;
}

export async function fetchProfile(baseUrl: string, profileId: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${baseUrl}/profiles/${profileId}`);
  if (!response.ok) return null;
  return response.json() as Promise<Record<string, unknown>>;
}

export function rememberAccessToken(token: string): void {
  localStorage.setItem('camera-access-token', token);
}

export function readExport(fileName: string): Promise<Response> {
  return fetch(`/api/exports/${fileName}`);
}
