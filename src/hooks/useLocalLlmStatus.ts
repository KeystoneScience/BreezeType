import { useCallback, useEffect, useState } from "react";
import { commands, type LocalLlmStatus } from "@/bindings";

type LocalLlmStatusResult = {
  status: LocalLlmStatus | null;
  error: string | null;
  refresh: () => Promise<void>;
};

export const useLocalLlmStatus = (enabled: boolean): LocalLlmStatusResult => {
  const [status, setStatus] = useState<LocalLlmStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await commands.getLocalLlmStatus();
      if (result.status === "ok") {
        setStatus(result.data);
        setError(null);
      } else {
        console.error("Failed to load local cleanup status:", result.error);
        setError("BreezeType could not load cleanup status.");
      }
    } catch (err) {
      console.error("Failed to load local cleanup status:", err);
      setError("BreezeType could not load cleanup status.");
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      setError(null);
      return;
    }

    let cancelled = false;
    const refreshIfActive = async () => {
      if (cancelled) return;
      await refresh();
    };

    void refreshIfActive();
    const interval = window.setInterval(refreshIfActive, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, refresh]);

  return { status, error, refresh };
};
