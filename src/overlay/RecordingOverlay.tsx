import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./RecordingOverlay.css";
import { syncLanguageFromSettings } from "@/i18n";

type OverlayState = "recording" | "transcribing" | "clipboard";

const BAR_COUNT = 16;
const WAVEFORM_TICK_MS = 40;

const RecordingOverlay: React.FC = () => {
  const [isVisible, setIsVisible] = useState(false);
  const [state, setState] = useState<OverlayState>("recording");
  const smoothedLevelsRef = useRef<number[]>(Array(16).fill(0));
  const lastAppliedLevelsRef = useRef<number[]>(Array(16).fill(0));
  const lastLevelEventAtRef = useRef(0);
  const lastVolumeUpdateAtRef = useRef(0);
  const volumeRef = useRef(0);
  const volumeSmoothRef = useRef(0);
  const lastWaveformTickAtRef = useRef(0);
  const waveformRef = useRef<number[]>(Array(BAR_COUNT).fill(0));
  const [waveform, setWaveform] = useState<number[]>(Array(BAR_COUNT).fill(0));
  const carrierPhaseRef = useRef(0);
  const agcRef = useRef(0.35);
  const lastAgcUpdateAtRef = useRef(0);

  const stepVolumeEnvelope = useCallback((target: number) => {
    const now = performance.now();
    const last = lastVolumeUpdateAtRef.current;
    const dtMs = last > 0 ? Math.min(250, Math.max(0, now - last)) : 16;
    lastVolumeUpdateAtRef.current = now;
    const attackMs = 35;
    const releaseMs = 85;
    const tau = target > volumeSmoothRef.current ? attackMs : releaseMs;
    const alpha = 1 - Math.exp(-dtMs / tau);
    const next =
      volumeSmoothRef.current + (target - volumeSmoothRef.current) * alpha;
    volumeSmoothRef.current = next < 0.004 ? 0 : next;
  }, []);

  const applyMeterLevels = useCallback(
    (newLevels: number[]) => {
      // Apply smoothing to reduce jitter
      const smoothed = smoothedLevelsRef.current.map((prev, i) => {
        const target = newLevels[i] || 0;
        // Faster response, especially on release, so the overlay falls promptly.
        return prev * 0.6 + target * 0.4;
      });

      smoothedLevelsRef.current = smoothed;
      lastAppliedLevelsRef.current = smoothed;
      const avg =
        smoothed.reduce((sum, value) => sum + value, 0) /
        Math.max(1, smoothed.length);
      const peak = smoothed.reduce((max, value) => Math.max(max, value), 0);
      // The backend emits spectrum-ish buckets; average can stay low unless you're loud.
      // Keep peak weighting, but avoid over-boosting so normal speech doesn't pin the meter.
      const energy = Math.max(peak * 0.9, avg * 1.5);
      // Soft-knee response to keep natural headroom instead of hard saturation.
      const softKnee = 1 - Math.exp(-energy * 2.1);
      const target = Math.min(0.92, Math.pow(softKnee, 0.9));
      volumeRef.current = target;
      stepVolumeEnvelope(target);
    },
    [stepVolumeEnvelope],
  );

  const areLevelsSimilar = useCallback((a: number[], b: number[]) => {
    if (a.length !== b.length) {
      return false;
    }
    let maxDelta = 0;
    for (let i = 0; i < a.length; i += 1) {
      maxDelta = Math.max(maxDelta, Math.abs((a[i] || 0) - (b[i] || 0)));
    }
    return maxDelta < 0.01;
  }, []);

  useEffect(() => {
    let dispose = () => {};
    let disposed = false;

    const setupEventListeners = async () => {
      // Listen for show-overlay event from Rust
      const unlistenShow = await listen("show-overlay", async (event) => {
        // Sync language from settings each time overlay is shown
        await syncLanguageFromSettings();
        const overlayState = event.payload as OverlayState;
        setState(overlayState);
        lastLevelEventAtRef.current = Date.now();
        if (overlayState === "recording") {
          waveformRef.current = Array(BAR_COUNT).fill(0);
          setWaveform(Array(BAR_COUNT).fill(0));
          carrierPhaseRef.current = 0;
          agcRef.current = 0.35;
          lastAgcUpdateAtRef.current = 0;
        }
        setIsVisible(true);
      });

      // Listen for hide-overlay event from Rust
      const unlistenHide = await listen("hide-overlay", () => {
        setIsVisible(false);
        smoothedLevelsRef.current = Array(16).fill(0);
        lastAppliedLevelsRef.current = Array(16).fill(0);
        volumeRef.current = 0;
        volumeSmoothRef.current = 0;
        lastVolumeUpdateAtRef.current = 0;
        lastWaveformTickAtRef.current = 0;
        waveformRef.current = Array(BAR_COUNT).fill(0);
        setWaveform(Array(BAR_COUNT).fill(0));
        carrierPhaseRef.current = 0;
        agcRef.current = 0.35;
        lastAgcUpdateAtRef.current = 0;
      });

      // Listen for mic-level updates
      const unlistenLevel = await listen<number[]>("mic-level", (event) => {
        lastLevelEventAtRef.current = Date.now();
        applyMeterLevels(event.payload as number[]);
      });

      const cleanup = () => {
        unlistenShow();
        unlistenHide();
        unlistenLevel();
      };

      if (disposed) {
        cleanup();
        return;
      }
      dispose = cleanup;
    };

    void setupEventListeners();
    return () => {
      disposed = true;
      dispose();
    };
  }, [applyMeterLevels]);

  // Fallback for macOS versions where overlay mic-level events can pause during silence.
  useEffect(() => {
    if (!isVisible || state !== "recording") {
      return;
    }

    let disposed = false;
    const pollLevels = async () => {
      const sinceLastEvent = Date.now() - lastLevelEventAtRef.current;
      if (sinceLastEvent < 180) {
        return;
      }

      try {
        const polled = await invoke<number[]>("get_overlay_meter_levels");
        if (disposed || !Array.isArray(polled) || polled.length === 0) {
          return;
        }

        if (
          sinceLastEvent > 550 &&
          areLevelsSimilar(polled, lastAppliedLevelsRef.current)
        ) {
          // No fresh updates and no meter change: force graceful decay.
          applyMeterLevels(lastAppliedLevelsRef.current.map((v) => v * 0.55));
          return;
        }

        if (sinceLastEvent > 900) {
          // Events are stale for a long time; do not trust polled highs as "live".
          applyMeterLevels(
            polled.map((value, i) =>
              Math.min(value, (lastAppliedLevelsRef.current[i] || 0) * 0.65),
            ),
          );
          return;
        }

        applyMeterLevels(polled);
      } catch {
        if (sinceLastEvent > 550) {
          applyMeterLevels(lastAppliedLevelsRef.current.map((v) => v * 0.55));
        }
      }
    };

    void pollLevels();
    const intervalId = window.setInterval(() => {
      void pollLevels();
    }, 120);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [applyMeterLevels, areLevelsSimilar, isVisible, state]);

  // Build a smooth right-to-left scrolling waveform: newest sample on the right.
  useEffect(() => {
    const shouldAnimateWaveform = isVisible && state === "recording";
    if (!shouldAnimateWaveform) {
      return;
    }

    let disposed = false;

    const tick = () => {
      const now = performance.now();
      const last = lastWaveformTickAtRef.current || now;
      const dtMs = Math.min(100, Math.max(0, now - last));
      lastWaveformTickAtRef.current = now;

      let sample = 0;
      // If events stall (some macOS builds), start decaying immediately instead of
      // waiting for the polling fallbacks.
      const sinceLastEvent = Date.now() - lastLevelEventAtRef.current;
      if (sinceLastEvent > 140) {
        const decayTauMs = 160;
        const decay = Math.exp(-dtMs / decayTauMs);
        volumeRef.current *= decay;
        if (volumeRef.current < 0.004) {
          volumeRef.current = 0;
        }
      }

      stepVolumeEnvelope(volumeRef.current);

      // Soft AGC to reduce mic-to-mic variance: track a slowly-decaying recent peak.
      const agcNow = performance.now();
      const agcLast = lastAgcUpdateAtRef.current;
      const agcDtMs =
        agcLast > 0 ? Math.min(250, Math.max(0, agcNow - agcLast)) : 16;
      lastAgcUpdateAtRef.current = agcNow;
      const agcDecayTauMs = 1600;
      agcRef.current *= Math.exp(-agcDtMs / agcDecayTauMs);
      agcRef.current = Math.max(0.12, agcRef.current);
      agcRef.current = Math.max(agcRef.current, volumeRef.current);

      // Gate on the smoothed envelope to avoid animating on tiny background noise,
      // but normalize the instantaneous volume to preserve speech texture.
      const rawGate = 0.018;
      const raw = volumeRef.current;
      const gated = volumeSmoothRef.current > rawGate ? raw : 0;
      const normalized = agcRef.current > 0 ? gated / agcRef.current : 0;
      const shaped =
        normalized > 0 ? Math.pow(Math.min(1, normalized), 0.92) : 0;
      sample = shaped < 0.012 ? 0 : shaped;

      if (sample > 0) {
        carrierPhaseRef.current += dtMs * 0.016; // ~2.5 cycles/sec
        if (carrierPhaseRef.current > Math.PI * 2) {
          carrierPhaseRef.current -= Math.PI * 2;
        }
      }
      const next = waveformRef.current.slice(1);
      next.push(sample);
      waveformRef.current = next;
      if (!disposed) {
        setWaveform(next);
      }
    };

    tick();
    const intervalId = window.setInterval(tick, WAVEFORM_TICK_MS);
    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [isVisible, state, stepVolumeEnvelope]);

  const overlayClass = `recording-overlay ${isVisible ? "fade-in" : ""} ${
    state === "transcribing" ? "is-transcribing" : ""
  } ${state === "clipboard" ? "is-clipboard" : ""} ${
    state === "recording" || state === "transcribing" ? "is-stop-clickable" : ""
  }`;

  const showBars = state === "recording";
  const showSpinner = state === "transcribing";
  const isStopClickable = state === "recording" || state === "transcribing";

  const handleOverlayMouseDown = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !isStopClickable) {
        return;
      }
      event.preventDefault();
      void invoke("cancel_operation").catch(() => undefined);
    },
    [isStopClickable],
  );

  const displayLevels = useMemo(() => {
    const phase = carrierPhaseRef.current;
    return waveform.map((v, i) => {
      // Traveling ripple so it reads as motion even when volume is steady.
      const ripple = 0.11 * Math.sin(phase + i * 0.78);
      const out = v * (1 + ripple);
      return Math.max(0, Math.min(1, out));
    });
  }, [waveform]);

  return (
    <div className="overlay-shell">
      <div
        className={overlayClass}
        onMouseDown={handleOverlayMouseDown}
        title={isStopClickable ? "Click to stop" : undefined}
      >
        {showBars && (
          <div className="bars-container">
            {displayLevels.map((v, i) => {
              const progress =
                displayLevels.length > 1 ? i / (displayLevels.length - 1) : 0;
              const ease = Math.pow(v, 0.72);
              const height = Math.min(20, 3 + ease * 17);
              // Slightly emphasize the newest samples (right side).
              const ageBoost = 0.75 + progress * 0.25;
              const opacity = Math.min(0.95, (0.55 + ease * 0.4) * ageBoost);

              return (
                <div
                  key={i}
                  className="bar"
                  style={{
                    height: `${height}px`,
                    transition: "height 50ms ease-out, opacity 100ms ease-out",
                    opacity,
                  }}
                />
              );
            })}
          </div>
        )}
        {showSpinner && <div className="spinner" />}
        {state === "clipboard" && (
          <div className="clipboard-toast" aria-hidden="true">
            <svg
              className="clipboard-check-icon"
              viewBox="0 0 24 24"
              role="img"
            >
              <path
                className="clipboard-check-body"
                d="M16 4h-1.35a2.65 2.65 0 0 0-5.3 0H8a2 2 0 0 0-2 2v2.2h12V6a2 2 0 0 0-2-2z"
              />
              <path
                className="clipboard-check-body"
                d="M6 9.2V18a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9.2z"
              />
              <path
                className="clipboard-check-mark"
                d="M9.2 14.2l2.1 2.1 4.1-4.2"
              />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
};

export default RecordingOverlay;
