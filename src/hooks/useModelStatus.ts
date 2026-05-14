import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { commands } from "@/bindings";

export type ModelStatusState = "ready" | "loading" | "issue";

interface ModelStateEvent {
  event_type: string;
  model_id?: string;
  error?: string;
}

const TARGET_MODEL_ID = "parakeet-tdt-0.6b-v3";

export const useModelStatus = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ModelStatusState>("loading");
  const [message, setMessage] = useState<string>("");

  const updateStatusFromBackend = async () => {
    try {
      const [currentResult, modelInfoResult] = await Promise.all([
        commands.getCurrentModel(),
        commands.getModelInfo(TARGET_MODEL_ID),
      ]);

      const selectedModel =
        currentResult.status === "ok" ? currentResult.data : "";
      const modelInfo =
        modelInfoResult.status === "ok" ? modelInfoResult.data : null;

      if (!selectedModel) {
        setStatus("loading");
        setMessage("");
        return;
      }

      if (selectedModel !== TARGET_MODEL_ID) {
        setStatus("issue");
        setMessage(t("modelSelector.modelError"));
        return;
      }

      if (!modelInfo) {
        setStatus("issue");
        setMessage(t("modelSelector.modelError"));
        return;
      }

      if (modelInfo.is_downloaded) {
        setStatus("ready");
        setMessage("");
        return;
      }
      setStatus("loading");
      setMessage("");
    } catch {
      setStatus("loading");
      setMessage("");
    }
  };

  useEffect(() => {
    updateStatusFromBackend();

    const modelStateUnlisten = listen<ModelStateEvent>(
      "model-state-changed",
      (event) => {
        if (event.payload.model_id !== TARGET_MODEL_ID) return;
        switch (event.payload.event_type) {
          case "loading_started":
            setStatus("loading");
            setMessage("");
            break;
          case "loading_completed":
            setStatus("ready");
            setMessage("");
            break;
          case "unloaded":
            setStatus("ready");
            setMessage("");
            break;
          case "loading_failed":
            console.error("Readiness check failed:", event.payload.error);
            setStatus("issue");
            setMessage(t("modelSelector.modelError"));
            break;
          default:
            break;
        }
      },
    );

    const downloadUnlisten = listen("model-download-progress", (event) => {
      if ((event.payload as { model_id?: string }).model_id !== TARGET_MODEL_ID)
        return;
      setStatus("loading");
      setMessage("");
    });

    const downloadCompleteUnlisten = listen<string>(
      "model-download-complete",
      (event) => {
        if (event.payload === TARGET_MODEL_ID) {
          setStatus("ready");
          setMessage("");
        }
      },
    );

    const extractStartUnlisten = listen<string>(
      "model-extraction-started",
      (event) => {
        if (event.payload === TARGET_MODEL_ID) {
          setStatus("loading");
          setMessage("");
        }
      },
    );

    const extractFailUnlisten = listen<{
      model_id: string;
      error?: string;
    }>("model-extraction-failed", (event) => {
      if (event.payload.model_id === TARGET_MODEL_ID) {
        console.error("Readiness setup failed:", event.payload.error);
        setStatus("issue");
        setMessage(t("modelSelector.modelError"));
      }
    });

    return () => {
      modelStateUnlisten.then((fn) => fn());
      downloadUnlisten.then((fn) => fn());
      downloadCompleteUnlisten.then((fn) => fn());
      extractStartUnlisten.then((fn) => fn());
      extractFailUnlisten.then((fn) => fn());
    };
  }, [t]);

  return { status, message };
};
