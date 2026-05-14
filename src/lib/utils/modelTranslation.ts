import type { TFunction } from "i18next";
import type { ModelInfo } from "@/bindings";

/**
 * Get the display name for the local speech setup.
 * @param model - The model info object
 * @param t - The translation function from useTranslation
 * @returns A product-facing setup name. Raw implementation names are not shown.
 */
export function getTranslatedModelName(model: ModelInfo, t: TFunction): string {
  const translationKey = `onboarding.models.${model.id}.name`;
  const translated = t(translationKey, { defaultValue: "" });
  return translated !== "" ? translated : "BreezeType setup";
}

/**
 * Get the display description for the local speech setup.
 * @param model - The model info object
 * @param t - The translation function from useTranslation
 * @returns Product-facing setup copy. Raw implementation descriptions are not shown.
 */
export function getTranslatedModelDescription(
  model: ModelInfo,
  t: TFunction,
): string {
  const translationKey = `onboarding.models.${model.id}.description`;
  const translated = t(translationKey, { defaultValue: "" });
  return translated !== "" ? translated : "Required for fast local dictation.";
}
