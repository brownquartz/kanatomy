// src/LanguageSettings.js
// 説明言語を選ぶための小さなトグルボタン群。全ページ共通で表示する想定。
import React from 'react';
import { AVAILABLE_LANGUAGES, useLanguages } from './LanguageContext';

export default function LanguageSettings() {
  const { langs, toggleLang } = useLanguages();

  return (
    <div className="language-settings">
      <span className="language-settings__label">説明言語:</span>
      {AVAILABLE_LANGUAGES.map(({ code, label }) => (
        <button
          key={code}
          className={langs.includes(code) ? 'active' : ''}
          onClick={() => toggleLang(code)}
          type="button"
        >
          {label}
        </button>
      ))}
    </div>
  );
}
