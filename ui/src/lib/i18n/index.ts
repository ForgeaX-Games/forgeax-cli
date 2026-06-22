import en from "./en";
import zh from "./zh";
export type Messages = Record<keyof typeof en, string>;
export const locales = { en, zh } as const;
export type Locale = keyof typeof locales;
export const defaultLocale: Locale = "en";
