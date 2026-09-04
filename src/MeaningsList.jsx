// src/MeaningsList.js
// 選択中の言語ぶんだけ、意味(meanings)を並べて表示する共通コンポーネント。
// データが無い言語は自動的にスキップする。
import React from 'react';
import { AVAILABLE_LANGUAGES, useLanguages } from './LanguageContext';

const LABELS = Object.fromEntries(AVAILABLE_LANGUAGES.map(l => [l.code, l.label]));

export default function MeaningsList({ meanings, ordered = false }) {
  const { langs } = useLanguages();
  if (!meanings) return null;

  const blocks = langs
    .map(code => ({ code, values: (meanings[code] || []).filter(Boolean) }))
    .filter(b => b.values.length > 0);

  if (!blocks.length) return null;

  const ListTag = ordered ? 'ol' : 'ul';

  return (
    <div className="meanings-list">
      {blocks.map(({ code, values }) => (
        <div key={code} className="meanings-list__block">
          {langs.length > 1 && (
            <p className="meanings-list__lang-label">{LABELS[code] || code}</p>
          )}
          <ListTag>
            {values.map((v, i) => <li key={i}>{v}</li>)}
          </ListTag>
        </div>
      ))}
    </div>
  );
}
