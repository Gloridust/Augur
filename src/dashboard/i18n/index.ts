import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './en.json';
import zh from './zh.json';

export const SUPPORTED_LANGUAGES = ['en', 'zh'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const fallbackFromBrowser = (): SupportedLanguage => {
  const ui = chrome?.i18n?.getUILanguage?.() ?? navigator.language;
  return ui.toLowerCase().startsWith('zh') ? 'zh' : 'en';
};

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
    fallbackLng: fallbackFromBrowser(),
    supportedLngs: SUPPORTED_LANGUAGES,
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'chromehomepage:lang',
      caches: ['localStorage'],
    },
  });

export default i18n;
