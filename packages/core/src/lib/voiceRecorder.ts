/**
 * Voice-message recording (MediaRecorder). Produces a File that rides the
 * ordinary encrypted-attachment pipeline — a voice message IS an attachment,
 * so E2EE, upload and download come for free. Codec is whatever the webview
 * offers: Opus/WebM on WebView2 & most WKWebViews, AAC/MP4 as the fallback.
 */

export interface VoiceRecording {
  /** Stop and finalize; resolves to the recorded file (null if empty). */
  stop: () => Promise<File | null>;
  /** Abort and discard everything. */
  cancel: () => void;
}

export async function startVoiceRecording(): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
    (m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m),
  );
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start(250);
  const releaseMic = () => stream.getTracks().forEach((t) => t.stop());
  return {
    stop: () =>
      new Promise((resolve) => {
        recorder.onstop = () => {
          releaseMic();
          const type = recorder.mimeType || mime || "audio/webm";
          const ext = type.includes("mp4") ? "m4a" : "webm";
          const blob = new Blob(chunks, { type });
          resolve(
            blob.size > 0 ? new File([blob], `message-vocal.${ext}`, { type }) : null,
          );
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        /* already stopped */
      }
      releaseMic();
    },
  };
}
