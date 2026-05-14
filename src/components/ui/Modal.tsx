import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

type ModalWidth = "sm" | "md" | "lg";

interface ModalProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  open: boolean;
  width?: ModalWidth;
  bodyClassName?: string;
  onClose: () => void;
  onExited?: () => void;
  children: React.ReactNode;
  closeLabel?: string;
}

const panelWidthBySize: Record<ModalWidth, string> = {
  sm: "max-w-md",
  md: "max-w-3xl",
  lg: "max-w-5xl",
};

export const MODAL_TRANSITION_MS = 320;

export const Modal: React.FC<ModalProps> = ({
  title,
  subtitle,
  open,
  width = "md",
  bodyClassName = "px-6 py-6",
  onClose,
  onExited,
  children,
  closeLabel = "Close modal",
}) => {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const onExitedRef = useRef(onExited);

  useEffect(() => {
    onExitedRef.current = onExited;
  }, [onExited]);

  useEffect(() => {
    if (open) {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setMounted(true);
      return;
    }

    setVisible(false);
    if (!mounted) return;
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = window.setTimeout(() => {
      setMounted(false);
      closeTimerRef.current = null;
      onExitedRef.current?.();
    }, MODAL_TRANSITION_MS);
  }, [open, mounted]);

  useEffect(() => {
    if (!mounted || !open) return;
    const frame = window.requestAnimationFrame(() => {
      setVisible(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [mounted, open]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        className={`absolute inset-0 bg-black/35 transition-opacity duration-[320ms] ease-out ${
          visible ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
        aria-label={closeLabel}
      />
      <div
        className={`liquid-glass relative w-full ${panelWidthBySize[width]} max-h-[86vh] overflow-hidden rounded-[28px] transition-opacity duration-[320ms] ease-out will-change-[opacity] ${
          visible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="liquid-separator flex items-center justify-between gap-3 border-b px-6 py-5">
          <div className="min-w-0">
            <div className="truncate text-xl font-medium text-zinc-900 dark:text-zinc-100">
              {title}
            </div>
            {subtitle ? (
              <div className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                {subtitle}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="modal-close-button"
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          className={`max-h-[calc(86vh-86px)] overflow-y-auto ${bodyClassName}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
};
