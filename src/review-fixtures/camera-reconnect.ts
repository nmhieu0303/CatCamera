// Deliberately flawed reconnect fixture for exercising SDK lifecycle checks.

type CameraPlayer = {
  connect(): Promise<void>;
  on(event: 'close' | 'error', listener: (error?: Error) => void): void;
  start(): void;
};

declare function createCameraPlayer(serial: string): CameraPlayer;

let activePlayer: CameraPlayer | undefined;

export async function reconnectCamera(serial: string): Promise<void> {
  activePlayer = createCameraPlayer(serial);
  activePlayer.on('close', () => reconnectCamera(serial));
  activePlayer.on('error', () => reconnectCamera(serial));
  await activePlayer.connect();
  activePlayer.start();
}
