import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useModelStatus } from "../../hooks/useModelStatus";

const ModelStatusIndicator: React.FC = () => {
  const { t } = useTranslation();
  const { status, message } = useModelStatus();
  const [showTooltip, setShowTooltip] = useState(false);

  const dotClass = (() => {
    switch (status) {
      case "ready":
        return "bg-blue-500";
      case "loading":
        return "bg-zinc-400";
      default:
        return "bg-zinc-500";
    }
  })();

  const label = (() => {
    switch (status) {
      case "ready":
        return t("modelSelector.statusReady");
      case "loading":
        return t("modelSelector.statusLoading");
      default:
        return t("modelSelector.statusIssue");
    }
  })();
  const isInteractive = status === "issue";

  return (
    <div
      className={`relative flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400 ${
        isInteractive ? "cursor-pointer" : ""
      }`}
      onMouseEnter={() => isInteractive && setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={() => isInteractive && setShowTooltip((prev) => !prev)}
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onKeyDown={(event) => {
        if (!isInteractive) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setShowTooltip((prev) => !prev);
        }
      }}
    >
      <span className={`h-2 w-2 rounded-full ${dotClass}`} />
      <span>{label}</span>
      {status === "issue" && showTooltip && (
        <div className="liquid-glass absolute left-0 top-full z-50 mt-2 w-56 rounded-2xl px-3 py-2 text-xs text-zinc-700 dark:text-zinc-200">
          {message || t("modelSelector.modelError")}
        </div>
      )}
    </div>
  );
};

export default ModelStatusIndicator;
