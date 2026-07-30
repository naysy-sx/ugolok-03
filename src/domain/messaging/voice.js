export const VOICE_INLINE_MAX_BYTES = 32 * 1024;

export function shouldInlineVoice(rawByteLength) {
  return rawByteLength <= VOICE_INLINE_MAX_BYTES;
}

export function createVoiceRecorder(options = {}) {
  const MediaRecorderImpl = options.MediaRecorderImpl ?? globalThis.MediaRecorder;
  const getUserMediaImpl = options.getUserMediaImpl ?? ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
  let stream = null;
  let recorder = null;
  let chunks = [];

  async function start() {
    stream = await getUserMediaImpl({ audio: true });
    recorder = new MediaRecorderImpl(stream, { mimeType: 'audio/webm;codecs=opus' });
    chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.start();
  }

  function stopTracks() {
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }
  }

  async function stop() {
    if (!recorder) {
      return Promise.reject(new Error('запись не была начата'));
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        stopTracks();
        resolve(new Blob(chunks, { type: 'audio/webm' }));
      };
      recorder.stop();
    });
  }

  function cancel() {
    if (recorder) {
      recorder.onstop = null;
      recorder.stop();
    }
    stopTracks();
    chunks = [];
  }

  return { start, stop, cancel };
}
