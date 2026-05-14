import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { commands, type ModelInfo } from "@/bindings";
import { trackAppEvent, trackAppEventOnce } from "@/lib/telemetry";
import BreezeTypeTextLogo from "../icons/BreezeTypeTextLogo";

interface OnboardingProps {
  onModelSelected: () => void;
}

interface DownloadProgress {
  model_id: string;
  downloaded: number;
  total: number;
  percentage: number;
}

const formatEta = (seconds: number): string => {
  const clamped = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  if (mins <= 0) {
    return `${secs}s`;
  }
  return `${mins}m ${secs}s`;
};

const Onboarding: React.FC<OnboardingProps> = ({ onModelSelected }) => {
  const { t } = useTranslation();
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null);
  const [status, setStatus] = useState<
    "checking" | "downloading" | "extracting" | "loading" | "error"
  >("checking");
  const [downloadPercentage, setDownloadPercentage] = useState<number | null>(
    null,
  );
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const didStartDownload = useRef(false);
  const didTriggerLoad = useRef(false);
  const autoModelId = "parakeet-tdt-0.6b-v3";
  const downloadStatsRef = useRef({
    lastDownloaded: 0,
    lastTimestamp: 0,
    speed: 0,
  });
  const etaStateRef = useRef({
    smoothed: 0,
    lastUpdate: 0,
  });

  useEffect(() => {
    trackAppEventOnce("activation.model_setup_started", {
      model_id: autoModelId,
    });

    const triggerDownload = async () => {
      if (didStartDownload.current) return;
      didStartDownload.current = true;
      setStatus("downloading");
      setError(null);
      trackAppEvent("activation.model_download_started", {
        model_id: autoModelId,
      });

      try {
        const result = await commands.downloadModel(autoModelId);
        if (result.status === "error") {
          console.error("Setup download failed:", result.error);
          trackAppEvent("activation.model_download_failed", {
            model_id: autoModelId,
            reason: "command_error",
          });
          setStatus("error");
          setError(t("onboarding.errors.downloadModel"));
        }
      } catch (err) {
        console.error("Setup download failed:", err);
        trackAppEvent("activation.model_download_failed", {
          model_id: autoModelId,
          reason: "exception",
        });
        setStatus("error");
        setError(t("onboarding.errors.downloadModel"));
      }
    };

    const triggerLoad = async () => {
      if (didTriggerLoad.current) return;
      didTriggerLoad.current = true;
      setStatus("loading");

      try {
        const result = await commands.setActiveModel(autoModelId);
        if (result.status === "error") {
          console.error("Setup load failed:", result.error);
          setStatus("error");
          setError(t("modelSelector.modelError"));
        }
      } catch (err) {
        console.error("Setup load failed:", err);
        setStatus("error");
        setError(t("modelSelector.modelError"));
      }
    };

    const loadModels = async () => {
      setStatus("checking");
      try {
        const result = await commands.getAvailableModels();
        if (result.status === "ok") {
          const model = result.data.find((m) => m.id === autoModelId) ?? null;
          if (!model) {
            setStatus("error");
            setError(t("onboarding.errors.loadModels"));
            trackAppEvent("activation.model_setup_failed", {
              model_id: autoModelId,
              reason: "missing_model",
            });
            return;
          }
          setModelInfo(model);
          if (model.is_downloaded) {
            await triggerLoad();
          } else {
            await triggerDownload();
          }
        } else {
          console.error("Setup list failed:", result.error);
          setStatus("error");
          setError(t("onboarding.errors.loadModels"));
          trackAppEvent("activation.model_setup_failed", {
            model_id: autoModelId,
            reason: "list_models_failed",
          });
        }
      } catch (err) {
        console.error("Failed to load models:", err);
        setStatus("error");
        setError(t("onboarding.errors.loadModels"));
        trackAppEvent("activation.model_setup_failed", {
          model_id: autoModelId,
          reason: "exception",
        });
      }
    };

    const progressUnlisten = listen<DownloadProgress>(
      "model-download-progress",
      (event) => {
        if (event.payload.model_id !== autoModelId) return;
        setStatus("downloading");
        setDownloadPercentage(event.payload.percentage);

        const now = Date.now();
        const { downloaded, total } = event.payload;
        const stats = downloadStatsRef.current;
        const etaState = etaStateRef.current;

        if (stats.lastTimestamp > 0 && downloaded > stats.lastDownloaded) {
          const deltaBytes = downloaded - stats.lastDownloaded;
          const deltaSeconds = (now - stats.lastTimestamp) / 1000;
          if (deltaSeconds > 0) {
            const instantSpeed = deltaBytes / deltaSeconds;
            stats.speed =
              stats.speed > 0
                ? stats.speed * 0.8 + instantSpeed * 0.2
                : instantSpeed;
            const remaining = total - downloaded;
            if (stats.speed > 0 && remaining > 0) {
              const rawEta = remaining / stats.speed;
              const smoothed =
                etaState.smoothed > 0
                  ? etaState.smoothed * 0.85 + rawEta * 0.15
                  : rawEta;
              etaState.smoothed = smoothed;

              if (now - etaState.lastUpdate > 900) {
                const rounded = Math.max(1, Math.round(smoothed / 5) * 5);
                setEtaSeconds(rounded);
                etaState.lastUpdate = now;
              }
            }
          }
        }

        stats.lastDownloaded = downloaded;
        stats.lastTimestamp = now;
      },
    );

    const downloadCompleteUnlisten = listen<string>(
      "model-download-complete",
      (event) => {
        if (event.payload === autoModelId) {
          trackAppEventOnce(
            "activation.model_download_completed",
            {
              model_id: autoModelId,
            },
            `model_download_completed:${autoModelId}`,
          );
          setEtaSeconds(null);
          void triggerLoad();
        }
      },
    );

    const extractionStartedUnlisten = listen<string>(
      "model-extraction-started",
      (event) => {
        if (event.payload === autoModelId) {
          setEtaSeconds(null);
          setStatus("extracting");
        }
      },
    );

    const extractionCompletedUnlisten = listen<string>(
      "model-extraction-completed",
      (event) => {
        if (event.payload === autoModelId) {
          setEtaSeconds(null);
          void triggerLoad();
        }
      },
    );

    const modelStateUnlisten = listen<{
      event_type: string;
      model_id?: string;
      error?: string;
    }>("model-state-changed", (event) => {
      if (event.payload.model_id !== autoModelId) return;
      if (event.payload.event_type === "loading_completed") {
        trackAppEvent("activation.model_ready", {
          model_id: autoModelId,
        });
        trackAppEventOnce("activation.first_model_ready", {
          model_id: autoModelId,
        });
        onModelSelected();
      }
      if (event.payload.event_type === "loading_failed") {
        console.error("Setup readiness failed:", event.payload.error);
        trackAppEvent("activation.model_setup_failed", {
          model_id: autoModelId,
          reason: "loading_failed",
        });
        setStatus("error");
        setError(t("modelSelector.modelError"));
      }
    });

    loadModels();

    return () => {
      progressUnlisten.then((fn) => fn());
      downloadCompleteUnlisten.then((fn) => fn());
      extractionStartedUnlisten.then((fn) => fn());
      extractionCompletedUnlisten.then((fn) => fn());
      modelStateUnlisten.then((fn) => fn());
    };
  }, [onModelSelected, t]);

  const etaLabel =
    etaSeconds && status === "downloading" ? `≈ ${formatEta(etaSeconds)}` : "";
  const progressValue = (() => {
    if (status === "downloading" && downloadPercentage !== null) {
      return Math.max(2, Math.min(98, downloadPercentage));
    }
    if (status === "extracting") return 80;
    if (status === "loading") return 92;
    return 12;
  })();

  return (
    <div className="inset-0 flex h-full w-full flex-col gap-8 p-8">
      <div className="shrink-0">
        <BreezeTypeTextLogo width={220} className="self-start opacity-95" />
      </div>

      <div className="mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col text-center">
        {error && (
          <div className="liquid-glass mb-4 shrink-0 rounded-2xl p-4">
            <p className="text-sm text-zinc-600 dark:text-zinc-300">{error}</p>
          </div>
        )}
        {!error && (
          <div className="mx-auto w-full max-w-md">
            <div className="liquid-glass rounded-3xl p-6">
              <div className="flex items-center gap-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full border border-black/5 bg-white/60 dark:border-white/10 dark:bg-zinc-900/60">
                  <div className="h-3 w-3 animate-pulse rounded-full bg-blue-600 dark:bg-blue-500"></div>
                </div>
                <div className="flex-1 text-left">
                  <div className="text-[15px] font-medium text-zinc-900 dark:text-zinc-100">
                    {t("footer.preparing")}
                  </div>
                  {etaLabel && (
                    <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {etaLabel}
                    </div>
                  )}
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
                    <div
                      className="h-full bg-blue-600 transition-all duration-500 dark:bg-blue-500"
                      style={{ width: `${progressValue}%` }}
                    ></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Onboarding;
