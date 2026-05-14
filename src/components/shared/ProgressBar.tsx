import React from "react";
import { useTranslation } from "react-i18next";

export interface ProgressData {
  id: string;
  percentage: number;
  speed?: number;
  label?: string;
}

interface ProgressBarProps {
  progress: ProgressData[];
  className?: string;
  size?: "small" | "medium" | "large";
  showSpeed?: boolean;
  showLabel?: boolean;
}

const ProgressBar: React.FC<ProgressBarProps> = ({
  progress,
  className = "",
  size = "medium",
  showSpeed = false,
  showLabel = false,
}) => {
  const { t } = useTranslation();
  const sizeClasses = {
    small: "w-16 h-1",
    medium: "w-20 h-1.5",
    large: "w-24 h-2",
  };

  const progressClasses = sizeClasses[size];

  if (progress.length === 0) {
    return null;
  }

  if (progress.length === 1) {
    const item = progress[0];
    const percentage = Math.max(0, Math.min(100, item.percentage));

    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <progress
          value={percentage}
          max={100}
          className={`${progressClasses} [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-black/10 [&::-webkit-progress-bar]:dark:bg-white/15 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-blue-600 [&::-webkit-progress-value]:dark:bg-blue-500`}
        />
        {(showSpeed || showLabel) && (
          <div className="min-w-fit text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
            {showLabel && item.label && (
              <span className="mr-2">{item.label}</span>
            )}
            {showSpeed && item.speed !== undefined && item.speed > 0 ? (
              <span>
                {t("progress.speed", {
                  defaultValue: "{{speed}} MB/s",
                  speed: item.speed.toFixed(1),
                })}
              </span>
            ) : showSpeed ? (
              <span>
                {t("progress.downloading", { defaultValue: "Downloading..." })}
              </span>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex gap-1">
        {progress.map((item) => {
          const percentage = Math.max(0, Math.min(100, item.percentage));
          return (
            <progress
              key={item.id}
              value={percentage}
              max={100}
              title={item.label || `${percentage}%`}
              className="h-1.5 w-3 [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-black/10 [&::-webkit-progress-bar]:dark:bg-white/15 [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-blue-600 [&::-webkit-progress-value]:dark:bg-blue-500"
            />
          );
        })}
      </div>
      <div className="min-w-fit text-xs text-zinc-500 dark:text-zinc-400">
        {t("progress.multipleDownloading", {
          defaultValue: "{{count}} downloading...",
          count: progress.length,
        })}
      </div>
    </div>
  );
};

export default ProgressBar;
