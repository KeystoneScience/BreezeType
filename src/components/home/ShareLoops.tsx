import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import { Share2, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/Button";
import { type HistoryStats } from "@/bindings";
import { getWebEndpoint } from "@/lib/serverApi";

interface ShareLoopsProps {
  stats: HistoryStats | null;
}

const RECEIPT_ACK_KEY = "breeze_receipt_acknowledged";

const formatDuration = (minutes: number) => {
  const rounded = Math.max(0, Math.round(minutes));
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours <= 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
};

const formatCompact = (value: number) => value.toLocaleString();

const ShareLoops: React.FC<ShareLoopsProps> = ({ stats }) => {
  const { t } = useTranslation();
  const [receiptDismissed, setReceiptDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const savedReceipt = window.localStorage.getItem(RECEIPT_ACK_KEY);
    setReceiptDismissed(savedReceipt === "true");
  }, []);

  const totalWords = stats?.total_words ?? 0;
  const totalAudioMinutes = stats?.total_audio_seconds
    ? stats.total_audio_seconds / 60
    : 0;
  const typingMinutes = stats?.total_words_with_duration
    ? stats.total_words_with_duration / 40
    : 0;
  const savedMinutes = Math.max(0, typingMinutes - totalAudioMinutes);

  const showReceipt = totalWords > 0 && !receiptDismissed;

  const handleCopy = async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(successMessage);
    } catch (error) {
      console.error("Failed to copy:", error);
      toast.error("Unable to copy right now.");
    }
  };

  const acknowledgeReceipt = () => {
    setReceiptDismissed(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(RECEIPT_ACK_KEY, "true");
    }
  };

  const receiptShareUrl = `${getWebEndpoint("/share/receipt")}?words=${encodeURIComponent(
    String(totalWords),
  )}&saved=${encodeURIComponent(formatDuration(savedMinutes))}`;

  return (
    <div className="relative space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {showReceipt && (
          <div className="relative overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-sm lg:col-span-2">
            <div className="absolute inset-0 profile-aurora opacity-60" />
            <div className="relative z-10 flex flex-col gap-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-text">
                <Sparkles className="h-4 w-4 text-accent" />
                {t("shareLoops.receiptTitle", {
                  defaultValue: "Voice receipt",
                })}
              </div>
              <div className="text-base font-semibold text-text">
                {t("shareLoops.receiptBody", {
                  defaultValue: "You spoke {{words}} words. Saved ~{{saved}}.",
                  words: formatCompact(totalWords),
                  saved: formatDuration(savedMinutes),
                })}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    handleCopy(
                      `BreezeType receipt - ${receiptShareUrl}`,
                      t("shareLoops.receiptCopied", {
                        defaultValue: "Receipt share card copied.",
                      }),
                    )
                  }
                >
                  <Share2 className="mr-1 h-3.5 w-3.5" />
                  {t("shareLoops.shareCard", { defaultValue: "Share card" })}
                </Button>
                <Button variant="ghost" size="sm" onClick={acknowledgeReceipt}>
                  {t("common.notNow", { defaultValue: "Not now" })}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ShareLoops;
