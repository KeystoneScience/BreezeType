import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useSettings } from "../../hooks/useSettings";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SettingContainer } from "../ui/SettingContainer";

interface ClipboardQuickPastesProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

interface QuickPasteRow {
  id: number;
  key: string;
  text: string;
}

const toRows = (map: Partial<{ [key: string]: string }>): QuickPasteRow[] =>
  Object.entries(map)
    .filter(([, text]) => typeof text === "string")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, text], index) => ({
      id: Date.now() + index,
      key,
      text: text as string,
    }));

const nextRowId = () => Date.now() + Math.floor(Math.random() * 100_000);

const blankRow = (): QuickPasteRow => ({
  id: nextRowId(),
  key: "",
  text: "",
});

const hasRowContent = (row: QuickPasteRow) =>
  row.key.trim().length > 0 || row.text.trim().length > 0;

const ensureTrailingBlankRow = (rows: QuickPasteRow[]): QuickPasteRow[] => {
  const rowsWithContent = rows.filter(hasRowContent);
  return [...rowsWithContent, blankRow()];
};

export const ClipboardQuickPastes: React.FC<ClipboardQuickPastesProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { settings, updateSetting, isUpdating } = useSettings();
  const quickPastes = settings?.clipboard_quick_pastes ?? {};
  const clipboardShortcut =
    settings?.bindings?.clipboard_history?.current_binding ?? "";
  const [rows, setRows] = useState<QuickPasteRow[]>(() =>
    ensureTrailingBlankRow(toRows(quickPastes)),
  );

  useEffect(() => {
    setRows(ensureTrailingBlankRow(toRows(quickPastes)));
  }, [quickPastes]);

  const isSaving = isUpdating("clipboard_quick_pastes");

  const reservedKeys = useMemo(() => {
    const keys = clipboardShortcut
      .split("+")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length === 1);
    return new Set(keys);
  }, [clipboardShortcut]);

  const reservedKeysLabel = useMemo(() => {
    const keys = Array.from(reservedKeys).sort();
    return keys.join(", ");
  }, [reservedKeys]);

  const updateRow = (id: number, patch: Partial<QuickPasteRow>) => {
    setRows((current) =>
      ensureTrailingBlankRow(
        current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
      ),
    );
  };

  const removeRow = (id: number) => {
    setRows((current) =>
      ensureTrailingBlankRow(current.filter((row) => row.id !== id)),
    );
  };

  const handleKeyCapture = (id: number, event: React.KeyboardEvent) => {
    if (event.key === "Tab") return;

    event.preventDefault();

    if (event.key === "Backspace" || event.key === "Delete") {
      updateRow(id, { key: "" });
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    if (event.key.length !== 1 || event.key.trim().length === 0) {
      return;
    }

    updateRow(id, { key: event.key.toLowerCase() });
  };

  const validateRows = (): Partial<{ [key: string]: string }> | null => {
    const nextMap: Partial<{ [key: string]: string }> = {};
    const seen = new Set<string>();

    for (const row of rows) {
      const key = row.key.trim().toLowerCase();
      const text = row.text;
      const trimmedText = text.trim();

      if (!key && !trimmedText) {
        continue;
      }

      if (key.length !== 1) {
        toast.error(t("settings.general.quickPastes.errors.invalidKey"));
        return null;
      }

      if (reservedKeys.has(key)) {
        toast.error(
          t("settings.general.quickPastes.errors.reservedKey", {
            key,
            shortcut: clipboardShortcut,
          }),
        );
        return null;
      }

      if (seen.has(key)) {
        toast.error(
          t("settings.general.quickPastes.errors.duplicateKey", { key }),
        );
        return null;
      }

      if (!trimmedText) {
        toast.error(
          t("settings.general.quickPastes.errors.emptyText", { key }),
        );
        return null;
      }

      seen.add(key);
      nextMap[key] = text;
    }

    return nextMap;
  };

  const save = async () => {
    const nextMap = validateRows();
    if (!nextMap) return;

    try {
      await updateSetting("clipboard_quick_pastes", nextMap);
      toast.success(t("settings.general.quickPastes.saved"));
    } catch (error) {
      console.error("Failed to save clipboard quick pastes:", error);
      toast.error(t("settings.general.quickPastes.errors.save"));
    }
  };

  return (
    <SettingContainer
      title={t("settings.general.quickPastes.title")}
      description={t("settings.general.quickPastes.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="stacked"
    >
      <div className="space-y-2">
        {rows.map((row) => {
          const isPlaceholderRow = !hasRowContent(row);
          return (
            <div
              key={row.id}
              className="flex flex-col gap-2 sm:flex-row sm:items-center"
            >
              <Input
                value={row.key}
                onKeyDown={(event) => handleKeyCapture(row.id, event)}
                readOnly={true}
                placeholder={t("settings.general.quickPastes.keyPlaceholder")}
                className="w-full text-center enabled:cursor-pointer enabled:caret-transparent sm:w-20 sm:shrink-0"
                variant="compact"
                disabled={isSaving}
              />
              <Input
                value={row.text}
                onChange={(event) =>
                  updateRow(row.id, { text: event.target.value })
                }
                placeholder={t("settings.general.quickPastes.textPlaceholder")}
                className="min-w-0 flex-1"
                variant="compact"
                disabled={isSaving}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => removeRow(row.id)}
                disabled={isSaving || isPlaceholderRow}
                className={`sm:shrink-0 ${isPlaceholderRow ? "invisible" : ""}`}
                tabIndex={isPlaceholderRow ? -1 : undefined}
                aria-hidden={isPlaceholderRow}
              >
                {t("common.remove")}
              </Button>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">
          {reservedKeysLabel
            ? t("settings.general.quickPastes.reserved", {
                keys: reservedKeysLabel,
                shortcut: clipboardShortcut,
              })
            : t("settings.general.quickPastes.noReserved")}
        </p>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={save}
          disabled={isSaving}
        >
          {t("common.save")}
        </Button>
      </div>
    </SettingContainer>
  );
};
