export interface CameraHandle {
  stream: MediaStream;
  stop(): void;
  settings(): MediaTrackSettings | null;
}

export async function openCamera(deviceId: string | null): Promise<CameraHandle> {
  const constraints: MediaStreamConstraints = {
    audio: false,
    video: deviceId
      ? {
          deviceId: { exact: deviceId },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 }
        }
      : {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 }
        }
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  return {
    stream,
    settings() {
      const track = stream.getVideoTracks()[0];
      return track ? track.getSettings() : null;
    },
    stop() {
      stream.getTracks().forEach((t) => t.stop());
    }
  };
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

export function pickRecorderMime(): string | null {
  const candidates = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

export function makeRecorder(stream: MediaStream): MediaRecorder | null {
  const mime = pickRecorderMime();
  if (!mime) return null;
  try {
    return new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
  } catch {
    return null;
  }
}
