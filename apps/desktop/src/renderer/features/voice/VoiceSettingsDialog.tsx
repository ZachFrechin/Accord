import { useEffect, useRef, useState } from 'react';
import { Mic, Volume2 } from 'lucide-react';
import { Dialog } from '../../components/Dialog';
import type { VoiceSettings } from '../../store/ui-store';

interface VoiceSettingsDialogProps {
  settings: VoiceSettings;
  onSave: (patch: Partial<VoiceSettings>) => void;
  onClose: () => void;
}

interface AudioDevice {
  deviceId: string;
  label: string;
}

export function VoiceSettingsDialog({
  settings,
  onSave,
  onClose,
}: VoiceSettingsDialogProps): React.JSX.Element {
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [previewLevel, setPreviewLevel] = useState(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    async function loadDevices() {
      // Demander la permission d'abord pour avoir les labels
      try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        tempStream.getTracks().forEach((t) => t.stop());
      } catch {
        // ignore
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      setInputDevices(
        devices
          .filter((d) => d.kind === 'audioinput')
          .map((d) => ({ deviceId: d.deviceId, label: d.label || `Micro ${d.deviceId.slice(0, 8)}` })),
      );
      setOutputDevices(
        devices
          .filter((d) => d.kind === 'audiooutput')
          .map((d) => ({ deviceId: d.deviceId, label: d.label || `Sortie ${d.deviceId.slice(0, 8)}` })),
      );
    }

    void loadDevices();
  }, []);

  useEffect(() => {
    // Visualiseur du micro pour tester l'entrée
    async function startPreview() {
      try {
        const constraints: MediaTrackConstraints = {
          echoCancellation: settings.enableEchoCancellation,
          noiseSuppression: settings.enableNoiseSuppression,
          autoGainControl: settings.enableAutoGainControl,
        };
        if (settings.inputDeviceId) {
          constraints.deviceId = { exact: settings.inputDeviceId };
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        streamRef.current = stream;
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        analyserRef.current = analyser;

        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          const avg = data.reduce((a, b) => a + b, 0) / data.length;
          setPreviewLevel(avg);
          animationRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // ignore
      }
    }

    void startPreview();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
      analyserRef.current = null;
    };
  }, [settings.inputDeviceId, settings.enableEchoCancellation, settings.enableNoiseSuppression, settings.enableAutoGainControl]);

  return (
    <Dialog title="Paramètres vocaux" onClose={onClose}>
      <div className="settings-dialog">
        {/* Entrée audio */}
        <section className="settings-section">
          <h3>Entrée audio</h3>
          <label>
            <span className="label-row">
              <Mic size={14} />
              Périphérique
            </span>
            <select
              value={settings.inputDeviceId ?? ''}
              onChange={(e) => onSave({ inputDeviceId: e.target.value || null })}
            >
              <option value="">Par défaut</option>
              {inputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="label-row">
              <Mic size={14} />
              Volume d'entrée ({settings.inputVolume}%)
            </span>
            <input
              type="range"
              min={0}
              max={200}
              value={settings.inputVolume}
              onChange={(e) => onSave({ inputVolume: Number(e.target.value) })}
            />
          </label>

          <div className="voice-meter-wrap">
            <div
              className="voice-meter-bar"
              style={{ width: `${Math.min(previewLevel, 100)}%` }}
            />
          </div>
        </section>

        {/* Sortie audio */}
        <section className="settings-section">
          <h3>Sortie audio</h3>
          <label>
            <span className="label-row">
              <Volume2 size={14} />
              Périphérique
            </span>
            <select
              value={settings.outputDeviceId ?? ''}
              onChange={(e) => onSave({ outputDeviceId: e.target.value || null })}
            >
              <option value="">Par défaut</option>
              {outputDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span className="label-row">
              <Volume2 size={14} />
              Volume de sortie ({settings.outputVolume}%)
            </span>
            <input
              type="range"
              min={0}
              max={200}
              value={settings.outputVolume}
              onChange={(e) => onSave({ outputVolume: Number(e.target.value) })}
            />
          </label>
        </section>

        {/* Traitement audio */}
        <section className="settings-section">
          <h3>Traitement audio</h3>

          <label className="toggle-row">
            <span>Annulation d'écho</span>
            <input
              type="checkbox"
              checked={settings.enableEchoCancellation}
              onChange={(e) => onSave({ enableEchoCancellation: e.target.checked })}
            />
          </label>

          <label className="toggle-row">
            <span>Suppression de bruit (WebRTC)</span>
            <input
              type="checkbox"
              checked={settings.enableNoiseSuppression}
              onChange={(e) => onSave({ enableNoiseSuppression: e.target.checked })}
            />
          </label>

          <label className="toggle-row">
            <span>Contrôle automatique du gain</span>
            <input
              type="checkbox"
              checked={settings.enableAutoGainControl}
              onChange={(e) => onSave({ enableAutoGainControl: e.target.checked })}
            />
          </label>

          <label className="toggle-row">
            <span>Réduction de bruit IA (RNNoise)</span>
            <input
              type="checkbox"
              checked={settings.enableRnnoise}
              onChange={(e) => onSave({ enableRnnoise: e.target.checked })}
            />
          </label>

          <label>
            Seuil du noise gate ({settings.noiseGateThreshold}%)
            <input
              type="range"
              min={0}
              max={100}
              value={settings.noiseGateThreshold}
              onChange={(e) => onSave({ noiseGateThreshold: Number(e.target.value) })}
            />
          </label>
        </section>
      </div>
    </Dialog>
  );
}
