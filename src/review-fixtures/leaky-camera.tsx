// Deliberately flawed React fixture for exercising lifecycle and race detection.
import { useEffect, useState } from 'react';

type Frame = { id: string; label: string };
type CameraPlayer = {
  on(event: 'frame', listener: (frame: Frame) => void): void;
  play(channel: number): void;
};

export function LeakyCameraPreview({ player, channel }: { player: CameraPlayer; channel: number }) {
  const [frames, setFrames] = useState<Frame[]>([]);

  useEffect(() => {
    player.on('frame', frame => setFrames(previous => [...previous, frame]));
    window.setInterval(() => player.play(channel), 1000);
  }, [player]);

  return <div>{frames.map(frame => <span key={frame.id}>{frame.label}</span>)}</div>;
}
