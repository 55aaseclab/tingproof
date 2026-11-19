import { useSyncExternalStore } from "react";
import { language, setLanguage, subscribeLanguage } from "../i18n.js";

export function useLanguage() {
  return useSyncExternalStore(subscribeLanguage, language, language);
}

export function LanguageButton() {
  const selected = useLanguage();
  const next = selected === "en" ? "zh" : "en";
  return (
    <button type="button" className="language-button" lang={next}
      aria-label={next === "zh" ? "切换为中文" : "Switch to English"}
      onClick={() => setLanguage(next)}>
      {next === "zh" ? "中文" : "English"}
    </button>
  );
}
