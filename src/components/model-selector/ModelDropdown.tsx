import React from "react";
import { useTranslation } from "react-i18next";
import type { ModelInfo } from "@/bindings";
import { formatModelSize } from "../../lib/utils/format";
import { ProgressBar } from "../shared";

interface DownloadProgress {
  model_id: string;
  downloaded: number;
  total: number;
  percentage: number;
}

interface ModelDropdownProps {
  models: ModelInfo[];
  currentModelId: string;
  downloadProgress: Map<string, DownloadProgress>;
  onModelSelect: (modelId: string) => void;
  onModelDownload: (modelId: string) => void;
  onModelDelete: (modelId: string) => Promise<void>;
  onError?: (error: string) => void;
}

const ModelDropdown: React.FC<ModelDropdownProps> = ({
  models,
  currentModelId,
  downloadProgress,
  onModelSelect,
  onModelDownload,
  onModelDelete,
  onError,
}) => {
  const { t } = useTranslation();
  const availableModels = models.filter((m) => m.is_downloaded);
  const downloadableModels = models.filter((m) => !m.is_downloaded);
  const isFirstRun = availableModels.length === 0 && models.length > 0;

  const handleDeleteClick = async (e: React.MouseEvent, modelId: string) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      await onModelDelete(modelId);
    } catch (err) {
      console.error("Failed to delete model:", err);
      const errorMsg = t("modelSelector.deleteError");
      onError?.(errorMsg);
    }
  };

  const handleModelClick = (modelId: string) => {
    if (downloadProgress.has(modelId)) {
      return; // Don't allow interaction while downloading
    }
    onModelSelect(modelId);
  };

  const handleDownloadClick = (modelId: string) => {
    if (downloadProgress.has(modelId)) {
      return; // Don't allow interaction while downloading
    }
    onModelDownload(modelId);
  };

  return (
    <div className="liquid-glass absolute bottom-full left-0 z-50 mb-2 w-72 rounded-2xl py-2">
      {/* First Run Welcome */}
      {isFirstRun && (
        <div className="border-b border-black/5 px-3 py-2 dark:border-white/10">
          <div className="mb-1 text-xs font-medium text-blue-600 dark:text-blue-500">
            {t("modelSelector.welcome")}
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400">
            {t("modelSelector.downloadPrompt")}
          </div>
        </div>
      )}

      {/* Available Models */}
      {availableModels.length > 0 && (
        <div>
          <div className="border-b border-black/5 px-3 py-1 text-xs font-medium text-zinc-500 dark:border-white/10 dark:text-zinc-400">
            {t("modelSelector.availableModels")}
          </div>
          {availableModels.map((model) => (
            <div
              key={model.id}
              onClick={() => handleModelClick(model.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleModelClick(model.id);
                }
              }}
              tabIndex={0}
              role="button"
              className={`w-full cursor-pointer px-3 py-2 text-left transition-colors focus:outline-none hover:bg-blue-500/10 ${
                currentModelId === model.id
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-500"
                  : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm">
                    {t("modelSelector.readyOptionTitle", {
                      defaultValue: "Ready",
                    })}
                  </div>
                  <div className="pr-4 text-xs italic text-zinc-500 dark:text-zinc-400">
                    {t("modelSelector.readyOptionDescription", {
                      defaultValue: "BreezeType is ready for local dictation.",
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {currentModelId === model.id && (
                    <div className="text-xs text-blue-600 dark:text-blue-500">
                      {t("modelSelector.active")}
                    </div>
                  )}
                  {currentModelId !== model.id && (
                    <button
                      onClick={(e) => handleDeleteClick(e, model.id)}
                      className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-blue-500/10 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100"
                      title={t("modelSelector.deleteModel")}
                    >
                      <svg
                        className="w-3 h-3"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Downloadable Models */}
      {downloadableModels.length > 0 && (
        <div>
          {(availableModels.length > 0 || isFirstRun) && (
            <div className="my-1 border-t border-black/5 dark:border-white/10" />
          )}
          <div className="px-3 py-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            {isFirstRun
              ? t("modelSelector.chooseModel")
              : t("modelSelector.downloadModels")}
          </div>
          {downloadableModels.map((model) => {
            const isDownloading = downloadProgress.has(model.id);
            const progress = downloadProgress.get(model.id);

            return (
              <div
                key={model.id}
                onClick={() => handleDownloadClick(model.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleDownloadClick(model.id);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-disabled={isDownloading}
                className={`w-full cursor-pointer px-3 py-2 text-left transition-colors focus:outline-none hover:bg-blue-500/10 ${
                  isDownloading
                    ? "cursor-not-allowed opacity-50 hover:bg-transparent"
                    : ""
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">
                      {t("modelSelector.setupOptionTitle", {
                        defaultValue: "BreezeType setup",
                      })}
                      {model.id === "parakeet-tdt-0.6b-v3" && isFirstRun && (
                        <span className="ml-2 rounded-full bg-blue-500/10 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-500">
                          {t("onboarding.recommended")}
                        </span>
                      )}
                    </div>
                    <div className="pr-4 text-xs italic text-zinc-500 dark:text-zinc-400">
                      {t("modelSelector.setupOptionDescription", {
                        defaultValue: "Required for fast local dictation.",
                      })}
                    </div>
                    <div className="mt-1 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                      {t("modelSelector.downloadSize")} ·{" "}
                      {formatModelSize(Number(model.size_mb))}
                    </div>
                  </div>
                  <div className="text-xs tabular-nums text-blue-600 dark:text-blue-500">
                    {isDownloading && progress
                      ? `${Math.max(0, Math.min(100, Math.round(progress.percentage)))}%`
                      : t("modelSelector.download")}
                  </div>
                </div>

                {isDownloading && progress && (
                  <div className="mt-2">
                    <ProgressBar
                      progress={[
                        {
                          id: model.id,
                          percentage: progress.percentage,
                          label: t("modelSelector.setupOptionTitle", {
                            defaultValue: "BreezeType setup",
                          }),
                        },
                      ]}
                      size="small"
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* No Models Available */}
      {availableModels.length === 0 && downloadableModels.length === 0 && (
        <div className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400">
          {t("modelSelector.noModelsAvailable")}
        </div>
      )}
    </div>
  );
};

export default ModelDropdown;
