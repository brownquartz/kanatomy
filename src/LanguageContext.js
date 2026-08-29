// src/LanguageContext.js
// 「意味の説明をどの言語で表示するか」をアプリ全体で共有するためのContext。
// 複数選択可能（例: 日本語＋韓国語を同時に表示）。設定はlocalStorageに保存する。
import React, { createContext, useContext, useState, useEffect } from 'react';

// 表示候補の言語一覧。データが無い言語を選んでも単に何も表示されないだけなので、
// 将来データを追加する言語もあらかじめここに足しておいてよい。
export const AVAILABLE_LANGUAGES = [
  { code: 'ja', label: '日本語' },
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어' },
];

const STORAGE_KEY = 'kanji-dict:meaning-langs';
const DEFAULT_LANGS = ['ja'];

function loadInitialLangs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LANGS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    // localStorageが使えない/壊れている場合はデフォルトにフォールバック
  }
  return DEFAULT_LANGS;
}

const LanguageContext = createContext({
  langs: DEFAULT_LANGS,
  toggleLang: () => {},
});

export function LanguageProvider({ children }) {
  const [langs, setLangs] = useState(loadInitialLangs);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(langs));
    } catch {
      // 保存できなくても致命的ではないので無視
    }
  }, [langs]);

  const toggleLang = (code) => {
    setLangs((prev) => {
      const has = prev.includes(code);
      if (has) {
        // 最低1つは選択された状態を保つ
        if (prev.length === 1) return prev;
        return prev.filter((c) => c !== code);
      }
      return [...prev, code];
    });
  };

  return (
    <LanguageContext.Provider value={{ langs, toggleLang }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguages() {
  return useContext(LanguageContext);
}
