/**
 * 快捷键映射：默认遵循 PRD 2.3.4（F7 后退、F8 播放/暂停、F9 前进），可在界面里改键，
 * 配置保存在 localStorage（设备级偏好，不属于项目数据）。
 */
import { useCallback, useEffect, useState } from "react";

export interface Keymap {
  playPause: string;
  seekBack: string;
  seekForward: string;
}

/** PRD 2.3.4 默认表。 */
export const DEFAULT_KEYMAP: Keymap = {
  playPause: "F8",
  seekBack: "F7",
  seekForward: "F9",
};

const STORAGE_KEY = "tingproof.keymap.v1";

export function isKeyAllowed(key: string): boolean {
  return (
    /^F\d{1,2}$/.test(key) ||
    /^[`\-=[\];',./\\]$/.test(key) ||
    /^[a-zA-Z0-9]$/.test(key)
  );
}

function loadKeymap(): Keymap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_KEYMAP;
    const parsed = JSON.parse(raw) as Partial<Keymap>;
    return {
      playPause: parsed.playPause ?? DEFAULT_KEYMAP.playPause,
      seekBack: parsed.seekBack ?? DEFAULT_KEYMAP.seekBack,
      seekForward: parsed.seekForward ?? DEFAULT_KEYMAP.seekForward,
    };
  } catch {
    return DEFAULT_KEYMAP;
  }
}

export interface KeymapApi extends Keymap {
  /** 进入监听状态：下一次按键将绑定到该动作。 */
  listeningFor: keyof Keymap | null;
  startListening: (action: keyof Keymap) => void;
  resetToDefaults: () => void;
}

export function useKeymap(): KeymapApi {
  const [keymap, setKeymap] = useState<Keymap>(loadKeymap);
  const [listeningFor, setListeningFor] = useState<keyof Keymap | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keymap));
    } catch {
      // localStorage 不可用时退化为本次会话内生效。
    }
  }, [keymap]);

  useEffect(() => {
    if (!listeningFor) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setListeningFor(null);
        return;
      }
      if (!isKeyAllowed(e.key)) return; // 忽略修饰键与不允许的键
      setKeymap((prev) => ({ ...prev, [listeningFor]: e.key }));
      setListeningFor(null);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [listeningFor]);

  const startListening = useCallback((action: keyof Keymap) => {
    setListeningFor(action);
  }, []);

  const resetToDefaults = useCallback(() => {
    setKeymap(DEFAULT_KEYMAP);
  }, []);

  return { ...keymap, listeningFor, startListening, resetToDefaults };
}
