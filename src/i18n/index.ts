import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { locale } from "@tauri-apps/plugin-os";
import { LANGUAGE_METADATA } from "./languages";
import { commands } from "@/bindings";
import en from "./locales/en/translation.json";

type LocaleModule = { default: Record<string, unknown> };

const LOCALE_LOADERS: Record<string, () => Promise<LocaleModule>> = {
  en: () => import("./locales/en/translation.json"),
  zh: () => import("./locales/zh/translation.json"),
  es: () => import("./locales/es/translation.json"),
  fr: () => import("./locales/fr/translation.json"),
  de: () => import("./locales/de/translation.json"),
  ja: () => import("./locales/ja/translation.json"),
  vi: () => import("./locales/vi/translation.json"),
  pl: () => import("./locales/pl/translation.json"),
  it: () => import("./locales/it/translation.json"),
  ru: () => import("./locales/ru/translation.json"),
};

const SUPPORTED_LANGUAGE_CODES = new Set(Object.keys(LOCALE_LOADERS));

const loadLocaleModule = async (langCode: string) => {
  const loader = LOCALE_LOADERS[langCode];
  if (!loader) return null;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await loader();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
  console.warn(`Failed to load locale "${langCode}"`, lastError);
  return null;
};

const ensureLocaleLoaded = async (langCode: string) => {
  if (i18n.hasResourceBundle(langCode, "translation")) return true;
  const module = await loadLocaleModule(langCode);
  if (!module) return false;
  i18n.addResourceBundle(langCode, "translation", module.default, true, true);
  return true;
};

// Preload English so keys never render on first paint.
const resources: Record<string, { translation: Record<string, unknown> }> = {
  en: { translation: en },
};

// Build supported languages list from discovered locales + metadata
export const SUPPORTED_LANGUAGES = Array.from(SUPPORTED_LANGUAGE_CODES).map(
  (code) => {
    const meta = LANGUAGE_METADATA[code];
    if (!meta) {
      console.warn(`Missing metadata for locale "${code}" in languages.ts`);
      return { code, name: code, nativeName: code, priority: undefined };
    }
    return {
      code,
      name: meta.name,
      nativeName: meta.nativeName,
      priority: meta.priority,
    };
  },
)
  .sort((a, b) => {
    // Sort by priority first (lower = higher), then alphabetically
    if (a.priority !== undefined && b.priority !== undefined) {
      return a.priority - b.priority;
    }
    if (a.priority !== undefined) return -1;
    if (b.priority !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });

export type SupportedLanguageCode = string;

// Check if a language code is supported
const getSupportedLanguage = (
  langCode: string | null | undefined,
): SupportedLanguageCode | null => {
  if (!langCode) return null;
  const code = langCode.split("-")[0].toLowerCase();
  return SUPPORTED_LANGUAGE_CODES.has(code) ? code : null;
};

// Initialize i18n with English as default
// Language will be synced from settings after init
i18n.use(initReactI18next).init({
  resources,
  lng: "en",
  fallbackLng: "en",
  interpolation: {
    escapeValue: false, // React already escapes values
  },
  react: {
    useSuspense: false, // Disable suspense for SSR compatibility
  },
});

// Sync language from app settings
export const syncLanguageFromSettings = async () => {
  try {
    const result = await commands.getAppSettings();
    if (result.status === "ok" && result.data.app_language) {
      const supported = getSupportedLanguage(result.data.app_language);
      if (supported) {
        if (await ensureLocaleLoaded(supported)) {
          if (supported !== i18n.language) {
            await i18n.changeLanguage(supported);
          }
        }
      }
    } else {
      // Fall back to system locale detection if no saved preference
      const systemLocale = await locale();
      const supported = getSupportedLanguage(systemLocale);
      if (supported) {
        if (await ensureLocaleLoaded(supported)) {
          if (supported !== i18n.language) {
            await i18n.changeLanguage(supported);
          }
        }
      }
    }
  } catch (e) {
    console.warn("Failed to sync language from settings:", e);
  }
};

// Run language sync on init
syncLanguageFromSettings();

export default i18n;
