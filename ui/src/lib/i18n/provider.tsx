import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { locales, defaultLocale, type Locale, type Messages } from "./index";

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: Messages;
}

const I18nContext = createContext<I18nContextValue>({
  locale: defaultLocale,
  setLocale: () => {},
  t: locales[defaultLocale],
});

function getSavedLocale(): Locale {
  const saved = localStorage.getItem("locale");
  if (saved === "zh" || saved === "en") return saved;
  const browserLang = navigator.language.slice(0, 2);
  return browserLang === "zh" ? "zh" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getSavedLocale);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem("locale", l);
  }, []);

  return (
    <I18nContext.Provider value={{ locale, setLocale, t: locales[locale] }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}

export function useT() {
  return useContext(I18nContext).t;
}
