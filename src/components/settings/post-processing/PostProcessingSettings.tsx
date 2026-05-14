import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCcw } from "lucide-react";
import { commands } from "@/bindings";

import { SettingsGroup } from "../../ui/SettingsGroup";
import { SettingContainer } from "../../ui/SettingContainer";
import { Button } from "../../ui/Button";
import { ResetButton } from "../../ui/ResetButton";
import { Input } from "../../ui/Input";
import { Dropdown } from "../../ui/Dropdown";
import { Textarea } from "../../ui/Textarea";
import { ToggleSwitch } from "../../ui/ToggleSwitch";

import { ProviderSelect } from "../PostProcessingSettingsApi/ProviderSelect";
import { BaseUrlField } from "../PostProcessingSettingsApi/BaseUrlField";
import { ApiKeyField } from "../PostProcessingSettingsApi/ApiKeyField";
import { ModelSelect } from "../PostProcessingSettingsApi/ModelSelect";
import { usePostProcessProviderState } from "../PostProcessingSettingsApi/usePostProcessProviderState";
import { useSettings } from "../../../hooks/useSettings";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

type OpenAICodexOAuthStatus = {
  connected: boolean;
  account_id: string | null;
  expires_at_ms: number | null;
  default_model: string;
  reasoning_effort: string;
};

const DisabledNotice: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div className="rounded-2xl border border-black/5 bg-white/55 p-4 dark:border-white/10 dark:bg-zinc-900/55">
    <p className="text-sm text-zinc-500 dark:text-zinc-400">{children}</p>
  </div>
);

const PostProcessingSettingsApiComponent: React.FC = () => {
  const { t } = useTranslation();
  const state = usePostProcessProviderState();
  const { settings, isUpdating, refreshSettings, setPostProcessProvider } =
    useSettings();
  const isCodexActive =
    settings?.post_process_provider_id === OPENAI_CODEX_PROVIDER_ID;
  const isLocalProvider = state.selectedProvider?.id === "local_llama";
  const isCodexProviderUpdating = isUpdating("post_process_provider_id");
  const [openAICodexStatus, setOpenAICodexStatus] =
    useState<OpenAICodexOAuthStatus | null>(null);
  const [isOpenAICodexBusy, setIsOpenAICodexBusy] = useState(false);
  const [openAICodexError, setOpenAICodexError] = useState<string | null>(null);

  const loadOpenAICodexStatus = React.useCallback(async () => {
    try {
      const status = await invoke<OpenAICodexOAuthStatus>(
        "get_openai_codex_oauth_status",
      );
      setOpenAICodexStatus(status);
      setOpenAICodexError(null);
    } catch (error) {
      console.error("Failed to load enhanced cleanup status:", error);
      setOpenAICodexError("BreezeType could not load cleanup status.");
    }
  }, []);

  useEffect(() => {
    void loadOpenAICodexStatus();
  }, [loadOpenAICodexStatus]);

  useEffect(() => {
    if (openAICodexStatus && !openAICodexStatus.connected && isCodexActive) {
      void setPostProcessProvider("local_llama");
    }
  }, [openAICodexStatus, isCodexActive, setPostProcessProvider]);

  const handleEmbedWithCodex = async () => {
    setIsOpenAICodexBusy(true);
    setOpenAICodexError(null);
    try {
      const status = await invoke<OpenAICodexOAuthStatus>(
        "connect_openai_codex_oauth",
      );
      setOpenAICodexStatus(status);
      await refreshSettings();
    } catch (error) {
      console.error("Failed to connect enhanced cleanup:", error);
      setOpenAICodexError(
        "BreezeType could not connect cleanup. Please try again.",
      );
    } finally {
      setIsOpenAICodexBusy(false);
    }
  };

  const handleCodexToggle = async (enabled: boolean) => {
    setOpenAICodexError(null);
    try {
      await setPostProcessProvider(
        enabled ? OPENAI_CODEX_PROVIDER_ID : "local_llama",
      );
    } catch (error) {
      console.error("Failed to update cleanup setting:", error);
      setOpenAICodexError(
        "BreezeType could not update cleanup. Please try again.",
      );
    }
  };

  const handleDisconnectOpenAICodex = async () => {
    setIsOpenAICodexBusy(true);
    setOpenAICodexError(null);
    try {
      await invoke("disconnect_openai_codex_oauth");
      await refreshSettings();
      await loadOpenAICodexStatus();
    } catch (error) {
      console.error("Failed to disconnect enhanced cleanup:", error);
      setOpenAICodexError(
        "BreezeType could not disconnect cleanup. Please try again.",
      );
    } finally {
      setIsOpenAICodexBusy(false);
    }
  };

  const codexConnected = !!openAICodexStatus?.connected;

  return (
    <>
      <SettingContainer
        title="Enhanced cleanup"
        description="Let BreezeType improve transcripts automatically when enhanced cleanup is available."
        descriptionMode="tooltip"
        layout="stacked"
        grouped={true}
      >
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {!codexConnected && (
              <Button
                onClick={handleEmbedWithCodex}
                disabled={isOpenAICodexBusy}
                variant="primary"
                size="md"
              >
                {isOpenAICodexBusy
                  ? "Connecting..."
                  : "Enable enhanced cleanup"}
              </Button>
            )}
            {codexConnected && (
              <Button
                onClick={handleDisconnectOpenAICodex}
                disabled={isOpenAICodexBusy}
                variant="secondary"
                size="md"
              >
                {t("settings.postProcessing.api.codex.disconnect")}
              </Button>
            )}
          </div>

          <p className="text-xs text-mid-gray">
            {codexConnected ? "Connected" : "Not connected"}
            {codexConnected &&
              (isCodexActive ? " · cleanup active" : " · cleanup off")}
          </p>
          {openAICodexError && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {openAICodexError}
            </p>
          )}
        </div>
      </SettingContainer>

      {codexConnected && (
        <ToggleSwitch
          checked={isCodexActive}
          onChange={(checked) => void handleCodexToggle(checked)}
          disabled={isOpenAICodexBusy}
          isUpdating={isCodexProviderUpdating}
          label="Use enhanced transcript cleanup"
          description="When enabled, BreezeType uses enhanced cleanup. Turn it off to use standard cleanup."
          descriptionMode="tooltip"
          grouped={true}
        />
      )}

      {isCodexActive ? (
        <SettingContainer
          title="Offline backup"
          description="BreezeType manages the offline backup automatically."
          descriptionMode="tooltip"
          layout="stacked"
          grouped={true}
        >
          <DisabledNotice>
            {t("settings.postProcessing.api.offlineBackup.notice", {
              defaultValue:
                "BreezeType will choose the best available offline backup.",
            })}
          </DisabledNotice>
        </SettingContainer>
      ) : (
        <>
          <SettingContainer
            title={t("settings.postProcessing.api.provider.title")}
            description={t("settings.postProcessing.api.provider.description")}
            descriptionMode="tooltip"
            layout="horizontal"
            grouped={true}
          >
            <div className="flex items-center gap-2">
              <ProviderSelect
                options={state.providerOptions}
                value={state.selectedProviderId}
                onChange={state.handleProviderSelect}
              />
            </div>
          </SettingContainer>

          {state.isAppleProvider ? (
            <SettingContainer
              title={t("settings.postProcessing.api.appleIntelligence.title")}
              description={t(
                "settings.postProcessing.api.appleIntelligence.description",
              )}
              descriptionMode="tooltip"
              layout="stacked"
              grouped={true}
            >
              <DisabledNotice>
                {t(
                  "settings.postProcessing.api.appleIntelligence.requirements",
                )}
              </DisabledNotice>
            </SettingContainer>
          ) : (
            <>
              {state.selectedProvider?.id === "custom" && (
                <SettingContainer
                  title={t("settings.postProcessing.api.baseUrl.title")}
                  description={t(
                    "settings.postProcessing.api.baseUrl.description",
                  )}
                  descriptionMode="tooltip"
                  layout="horizontal"
                  grouped={true}
                >
                  <div className="flex items-center gap-2">
                    <BaseUrlField
                      value={state.baseUrl}
                      onBlur={state.handleBaseUrlChange}
                      placeholder={t(
                        "settings.postProcessing.api.baseUrl.placeholder",
                      )}
                      disabled={state.isBaseUrlUpdating}
                      className="min-w-[380px]"
                    />
                  </div>
                </SettingContainer>
              )}

              {state.selectedProvider?.id !== "local_llama" && (
                <SettingContainer
                  title={t("settings.postProcessing.api.apiKey.title")}
                  description={t(
                    "settings.postProcessing.api.apiKey.description",
                  )}
                  descriptionMode="tooltip"
                  layout="horizontal"
                  grouped={true}
                >
                  <div className="flex items-center gap-2">
                    <ApiKeyField
                      value={state.apiKey}
                      onBlur={state.handleApiKeyChange}
                      placeholder={t(
                        "settings.postProcessing.api.apiKey.placeholder",
                      )}
                      disabled={state.isApiKeyUpdating}
                      className="min-w-[320px]"
                    />
                  </div>
                </SettingContainer>
              )}
            </>
          )}

          <SettingContainer
            title={t("settings.postProcessing.api.model.title")}
            description={
              state.isAppleProvider
                ? t("settings.postProcessing.api.model.descriptionApple")
                : state.isCustomProvider
                  ? t("settings.postProcessing.api.model.descriptionCustom")
                  : t("settings.postProcessing.api.model.descriptionDefault")
            }
            descriptionMode="tooltip"
            layout="stacked"
            grouped={true}
          >
            {isLocalProvider ? (
              <DisabledNotice>
                {t("settings.postProcessing.api.model.localNotice", {
                  defaultValue:
                    "BreezeType will choose the best available cleanup option.",
                })}
              </DisabledNotice>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <ModelSelect
                    value={state.model}
                    options={state.modelOptions}
                    disabled={state.isModelUpdating}
                    isLoading={state.isFetchingModels}
                    placeholder={
                      state.isAppleProvider
                        ? t(
                            "settings.postProcessing.api.model.placeholderApple",
                          )
                        : state.modelOptions.length > 0
                          ? t(
                              "settings.postProcessing.api.model.placeholderWithOptions",
                            )
                          : t(
                              "settings.postProcessing.api.model.placeholderNoOptions",
                            )
                    }
                    onSelect={state.handleModelSelect}
                    onCreate={state.handleModelCreate}
                    onBlur={() => {}}
                    className="flex-1 min-w-[380px]"
                  />
                  <ResetButton
                    onClick={state.handleRefreshModels}
                    disabled={state.isFetchingModels || state.isAppleProvider}
                    ariaLabel={t(
                      "settings.postProcessing.api.model.refreshModels",
                    )}
                    className="flex h-10 w-10 items-center justify-center"
                  >
                    <RefreshCcw
                      className={`h-4 w-4 ${state.isFetchingModels ? "animate-spin" : ""}`}
                    />
                  </ResetButton>
                </div>
              </div>
            )}
          </SettingContainer>
        </>
      )}
    </>
  );
};

const PostProcessingSettingsPromptsComponent: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating, refreshSettings } =
    useSettings();
  const [isCreating, setIsCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftText, setDraftText] = useState("");

  const prompts = getSetting("post_process_prompts") || [];
  const selectedPromptId = getSetting("post_process_selected_prompt_id") || "";
  const selectedPrompt =
    prompts.find((prompt) => prompt.id === selectedPromptId) || null;

  useEffect(() => {
    if (isCreating) return;

    if (selectedPrompt) {
      setDraftName(selectedPrompt.name);
      setDraftText(selectedPrompt.prompt);
    } else {
      setDraftName("");
      setDraftText("");
    }
  }, [
    isCreating,
    selectedPromptId,
    selectedPrompt?.name,
    selectedPrompt?.prompt,
  ]);

  const handlePromptSelect = (promptId: string | null) => {
    if (!promptId) return;
    updateSetting("post_process_selected_prompt_id", promptId);
    setIsCreating(false);
  };

  const handleCreatePrompt = async () => {
    if (!draftName.trim() || !draftText.trim()) return;

    try {
      const result = await commands.addPostProcessPrompt(
        draftName.trim(),
        draftText.trim(),
      );
      if (result.status === "ok") {
        await refreshSettings();
        updateSetting("post_process_selected_prompt_id", result.data.id);
        setIsCreating(false);
      }
    } catch (error) {
      console.error("Failed to create prompt:", error);
    }
  };

  const handleUpdatePrompt = async () => {
    if (!selectedPromptId || !draftName.trim() || !draftText.trim()) return;

    try {
      await commands.updatePostProcessPrompt(
        selectedPromptId,
        draftName.trim(),
        draftText.trim(),
      );
      await refreshSettings();
    } catch (error) {
      console.error("Failed to update prompt:", error);
    }
  };

  const handleDeletePrompt = async (promptId: string) => {
    if (!promptId) return;

    try {
      await commands.deletePostProcessPrompt(promptId);
      await refreshSettings();
      setIsCreating(false);
    } catch (error) {
      console.error("Failed to delete prompt:", error);
    }
  };

  const handleCancelCreate = () => {
    setIsCreating(false);
    if (selectedPrompt) {
      setDraftName(selectedPrompt.name);
      setDraftText(selectedPrompt.prompt);
    } else {
      setDraftName("");
      setDraftText("");
    }
  };

  const handleStartCreate = () => {
    setIsCreating(true);
    setDraftName("");
    setDraftText("");
  };

  const hasPrompts = prompts.length > 0;
  const isDirty =
    !!selectedPrompt &&
    (draftName.trim() !== selectedPrompt.name ||
      draftText.trim() !== selectedPrompt.prompt.trim());

  return (
    <SettingContainer
      title={t("settings.postProcessing.prompts.selectedPrompt.title")}
      description={t(
        "settings.postProcessing.prompts.selectedPrompt.description",
      )}
      descriptionMode="tooltip"
      layout="stacked"
      grouped={true}
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <Dropdown
            selectedValue={selectedPromptId || null}
            options={prompts.map((p) => ({
              value: p.id,
              label: p.name,
            }))}
            onSelect={(value) => handlePromptSelect(value)}
            placeholder={
              prompts.length === 0
                ? t("settings.postProcessing.prompts.noPrompts")
                : t("settings.postProcessing.prompts.selectPrompt")
            }
            disabled={
              isUpdating("post_process_selected_prompt_id") || isCreating
            }
            className="flex-1"
          />
          <Button
            onClick={handleStartCreate}
            variant="primary"
            size="md"
            disabled={isCreating}
          >
            {t("settings.postProcessing.prompts.createNew")}
          </Button>
        </div>

        {!isCreating && hasPrompts && selectedPrompt && (
          <div className="space-y-3">
            <div className="space-y-2 flex flex-col">
              <label className="text-sm font-semibold">
                {t("settings.postProcessing.prompts.promptLabel")}
              </label>
              <Input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptLabelPlaceholder",
                )}
                variant="compact"
              />
            </div>

            <div className="space-y-2 flex flex-col">
              <label className="text-sm font-semibold">
                {t("settings.postProcessing.prompts.promptInstructions")}
              </label>
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptInstructionsPlaceholder",
                )}
              />
              <p
                className="text-xs text-mid-gray/70"
                dangerouslySetInnerHTML={{
                  __html: t("settings.postProcessing.prompts.promptTip"),
                }}
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleUpdatePrompt}
                variant="primary"
                size="md"
                disabled={!draftName.trim() || !draftText.trim() || !isDirty}
              >
                {t("settings.postProcessing.prompts.updatePrompt")}
              </Button>
              <Button
                onClick={() => handleDeletePrompt(selectedPromptId)}
                variant="secondary"
                size="md"
                disabled={!selectedPromptId || prompts.length <= 1}
              >
                {t("settings.postProcessing.prompts.deletePrompt")}
              </Button>
            </div>
          </div>
        )}

        {!isCreating && !selectedPrompt && (
          <div className="p-3 bg-mid-gray/5 rounded border border-mid-gray/20">
            <p className="text-sm text-mid-gray">
              {hasPrompts
                ? t("settings.postProcessing.prompts.selectToEdit")
                : t("settings.postProcessing.prompts.createFirst")}
            </p>
          </div>
        )}

        {isCreating && (
          <div className="space-y-3">
            <div className="space-y-2 block flex flex-col">
              <label className="text-sm font-semibold text-text">
                {t("settings.postProcessing.prompts.promptLabel")}
              </label>
              <Input
                type="text"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptLabelPlaceholder",
                )}
                variant="compact"
              />
            </div>

            <div className="space-y-2 flex flex-col">
              <label className="text-sm font-semibold">
                {t("settings.postProcessing.prompts.promptInstructions")}
              </label>
              <Textarea
                value={draftText}
                onChange={(e) => setDraftText(e.target.value)}
                placeholder={t(
                  "settings.postProcessing.prompts.promptInstructionsPlaceholder",
                )}
              />
              <p
                className="text-xs text-mid-gray/70"
                dangerouslySetInnerHTML={{
                  __html: t("settings.postProcessing.prompts.promptTip"),
                }}
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleCreatePrompt}
                variant="primary"
                size="md"
                disabled={!draftName.trim() || !draftText.trim()}
              >
                {t("settings.postProcessing.prompts.createPrompt")}
              </Button>
              <Button
                onClick={handleCancelCreate}
                variant="secondary"
                size="md"
              >
                {t("settings.postProcessing.prompts.cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </SettingContainer>
  );
};

export const PostProcessingSettingsApi = React.memo(
  PostProcessingSettingsApiComponent,
);
PostProcessingSettingsApi.displayName = "PostProcessingSettingsApi";

export const PostProcessingSettingsPrompts = React.memo(
  PostProcessingSettingsPromptsComponent,
);
PostProcessingSettingsPrompts.displayName = "PostProcessingSettingsPrompts";

export const PostProcessingSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="w-full space-y-6">
      <SettingsGroup title={t("settings.postProcessing.prompts.title")}>
        <PostProcessingSettingsPrompts />
      </SettingsGroup>
    </div>
  );
};
