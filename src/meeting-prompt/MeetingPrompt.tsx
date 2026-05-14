import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { commands } from "@/bindings";
import { syncLanguageFromSettings } from "@/i18n";
import "./MeetingPrompt.css";

type MeetingPromptPayload = {
  source: string;
  detail?: string | null;
};

const AUTO_HIDE_MS = 20_000;
const HIDE_DELAY_MS = 180;

const MeetingPrompt: React.FC = () => {
  const { t } = useTranslation();
  const [isVisible, setIsVisible] = useState(false);
  const [payload, setPayload] = useState<MeetingPromptPayload | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hideTimeoutRef = useRef<number | null>(null);

  const hidePrompt = useCallback(async () => {
    if (hideTimeoutRef.current) {
      window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
    setIsVisible(false);
    setIsStarting(false);
    setError(null);
    window.setTimeout(() => {
      getCurrentWindow().hide().catch(() => {});
    }, HIDE_DELAY_MS);
  }, []);

  const dismissPrompt = useCallback(async () => {
    try {
      await commands.snoozeMeetingPrompt();
    } catch (err) {
      console.warn("Failed to snooze meeting prompt:", err);
    }
    hidePrompt();
  }, [hidePrompt]);

  useEffect(() => {
    let unlistenShow: (() => void) | null = null;
    let unlistenHide: (() => void) | null = null;

    const setup = async () => {
      unlistenShow = await listen<MeetingPromptPayload>(
        "meeting-prompt-show",
        async (event) => {
          await syncLanguageFromSettings();
          setPayload(event.payload);
          setIsStarting(false);
          setError(null);
          setIsVisible(true);

          if (hideTimeoutRef.current) {
            window.clearTimeout(hideTimeoutRef.current);
          }
          hideTimeoutRef.current = window.setTimeout(() => {
            hidePrompt();
          }, AUTO_HIDE_MS);
        },
      );

      unlistenHide = await listen("meeting-prompt-hide", () => {
        hidePrompt();
      });
    };

    setup();

    return () => {
      if (unlistenShow) unlistenShow();
      if (unlistenHide) unlistenHide();
      if (hideTimeoutRef.current) {
        window.clearTimeout(hideTimeoutRef.current);
      }
    };
  }, [hidePrompt]);

  const handleStart = async () => {
    if (isStarting) return;
    setIsStarting(true);
    setError(null);

    try {
      const result = await commands.startMeetingRecording({
        name: null,
        include_system_audio: true,
      });
      if (result.status === "ok") {
        await hidePrompt();
        return;
      }
      setError(result.error ?? t("meetingPrompt.startError"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("meetingPrompt.startError"));
    } finally {
      setIsStarting(false);
    }
  };

  const subtitle = payload?.detail
    ? payload.detail
    : payload?.source
      ? t("meetingPrompt.subtitle", { source: payload.source })
      : "";

  return (
    <div className="meeting-prompt-shell">
      <div className={`meeting-prompt ${isVisible ? "is-visible" : ""}`}>
        <button
          className="meeting-dismiss"
          onClick={dismissPrompt}
          aria-label={t("meetingPrompt.dismiss")}
        >
          <X className="meeting-dismiss-icon" aria-hidden="true" />
        </button>
        <div className="meeting-text">
          <div className="meeting-title">{t("meetingPrompt.title")}</div>
          {subtitle ? (
            <div className="meeting-subtitle">{subtitle}</div>
          ) : null}
        </div>
        <button
          className="meeting-action"
          onClick={handleStart}
          disabled={isStarting}
        >
          {isStarting
            ? t("meetingPrompt.starting")
            : t("meetingPrompt.startButton")}
        </button>
        {error ? <div className="meeting-error">{error}</div> : null}
      </div>
    </div>
  );
};

export default MeetingPrompt;
