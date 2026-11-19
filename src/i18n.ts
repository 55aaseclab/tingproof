export type Language = "en" | "zh";

function initialLanguage(): Language {
  if (typeof document !== "undefined") {
    const cookie = document.cookie.match(/(?:^|;\s*)praxis_locale=(en|zh)(?:;|$)/);
    if (cookie) return cookie[1] === "zh" ? "zh" : "en";
    if (location.pathname.startsWith("/apps/tingproof/")) {
      try {
        const shared = localStorage.getItem("praxis.locale");
        if (shared === "en" || shared === "zh") return shared;
      } catch { /* Storage can be disabled. */ }
    }
  }
  try { return localStorage.getItem("tingproof.locale") === "zh" ? "zh" : "en"; }
  catch { return "en"; }
}

let current = initialLanguage();
export const language = () => current;
const listeners = new Set<() => void>();

export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setLanguage(value: Language) {
  current = value;
  if (typeof document !== "undefined") {
    document.documentElement.lang = value === "zh" ? "zh-CN" : "en";
    document.title = value === "zh" ? "听校 TingProof" : "TingProof";
    if (location.pathname.startsWith("/apps/tingproof/")) {
      try { localStorage.setItem("praxis.locale", value); } catch { /* Cookie remains usable. */ }
      document.cookie = `praxis_locale=${value}; Path=/; SameSite=Lax; Max-Age=31536000${location.protocol === "https:" ? "; Secure" : ""}`;
    }
    try { localStorage.setItem("tingproof.locale", value); } catch { /* Use this session's choice. */ }
  }
  for (const notify of listeners) notify();
}

export function msg(english: string, chinese: string, ...values: unknown[]): string {
  const message = current === "en" ? english : chinese;
  return values.length ? message.replace(/\{(\d+)\}/g, (_, n: string) => String(values[Number(n)])) : message;
}
