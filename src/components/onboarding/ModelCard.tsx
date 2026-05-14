import React from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";
import type { ModelInfo } from "@/bindings";
import { formatModelSize } from "../../lib/utils/format";
import {
  getTranslatedModelName,
  getTranslatedModelDescription,
} from "../../lib/utils/modelTranslation";
import Badge from "../ui/Badge";

interface ModelCardProps {
  model: ModelInfo;
  variant?: "default" | "featured";
  disabled?: boolean;
  className?: string;
  onSelect: (modelId: string) => void;
}

const ModelCard: React.FC<ModelCardProps> = ({
  model,
  variant = "default",
  disabled = false,
  className = "",
  onSelect,
}) => {
  const { t } = useTranslation();
  const isFeatured = variant === "featured";

  // Get translated model name and description
  const displayName = getTranslatedModelName(model, t);
  const displayDescription = getTranslatedModelDescription(model, t);

  const baseButtonClasses =
    "group flex items-center justify-between rounded-3xl p-5 text-left transition-all duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

  const variantClasses = isFeatured
    ? "liquid-glass bg-blue-500/10 hover:scale-[1.02] hover:bg-blue-500/12"
    : "liquid-glass hover:scale-[1.02] hover:bg-white/85 dark:hover:bg-zinc-900/85";

  return (
    <button
      onClick={() => onSelect(model.id)}
      disabled={disabled}
      className={[baseButtonClasses, variantClasses, className]
        .filter(Boolean)
        .join(" ")}
      type="button"
    >
      <div className="flex flex-col">
        <div className="flex items-center gap-4">
          <h3 className="text-xl font-medium text-zinc-900 transition-colors group-hover:text-blue-600 dark:text-zinc-100 dark:group-hover:text-blue-500">
            {displayName}
          </h3>
          <DownloadSize sizeMb={Number(model.size_mb)} />
          {isFeatured && (
            <Badge variant="primary">{t("onboarding.recommended")}</Badge>
          )}
        </div>
        <p className="mt-1 text-sm leading-tight text-zinc-500 dark:text-zinc-400">
          {displayDescription}
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <p className="w-16 text-right text-xs text-zinc-500 dark:text-zinc-400">
            {t("onboarding.modelCard.accuracy")}
          </p>
          <div className="h-2 w-20 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-300 dark:bg-blue-500"
              style={{ width: `${model.accuracy_score * 100}%` }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <p className="w-16 text-right text-xs text-zinc-500 dark:text-zinc-400">
            {t("onboarding.modelCard.speed")}
          </p>
          <div className="h-2 w-20 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-300 dark:bg-blue-500"
              style={{ width: `${model.speed_score * 100}%` }}
            />
          </div>
        </div>
      </div>
    </button>
  );
};

const DownloadSize = ({ sizeMb }: { sizeMb: number }) => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-1.5 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
      <Download
        aria-hidden="true"
        className="h-3.5 w-3.5 text-zinc-500/70 dark:text-zinc-400/70"
        strokeWidth={1.75}
      />
      <span className="sr-only">{t("modelSelector.downloadSize")}</span>
      <span className="font-medium text-zinc-500 dark:text-zinc-400">
        {formatModelSize(sizeMb)}
      </span>
    </div>
  );
};

export default ModelCard;
