// src/DetailsPage.js
import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet';
import MeaningsList from './MeaningsList';
import PartsTree from './PartsTree';
import './App.css';

const API_URL = process.env.REACT_APP_API_URL ?? 'http://localhost:4000';
// meanji（辞書サイト、別リポジトリ/別デプロイ）への外部リンク。kanatomy はこの先の
// データ・コードには一切依存しない（一方向のリンクのみ）。
const MEANJI_URL = process.env.REACT_APP_MEANJI_URL ?? 'http://localhost:4001';

export default function DetailsPage({ kanji, onPartClick }) {
  const [data, setData] = useState(null);
  const [words, setWords] = useState(null);
  const [similar, setSimilar] = useState(null);
  const [tree, setTree] = useState(null);

  useEffect(() => {
    setData(null);
    fetch(`${API_URL}/api/kanji/${encodeURIComponent(kanji)}`)
      .then(r => r.json())
      .then(setData)
      .catch(console.error);
  }, [kanji]);

  useEffect(() => {
    setTree(null);
    fetch(`${API_URL}/api/kanji/${encodeURIComponent(kanji)}/tree`)
      .then(r => r.json())
      .then(d => setTree(d.tree))
      .catch(() => setTree(null));
  }, [kanji]);

  useEffect(() => {
    setSimilar(null);
    fetch(`${API_URL}/api/kanji/${encodeURIComponent(kanji)}/similar?limit=16`)
      .then(r => r.json())
      .then(d => setSimilar(d.results || []))
      .catch(() => setSimilar([]));
  }, [kanji]);

  useEffect(() => {
    setWords(null);
    // この漢字を使った熟語は meanji（別サービス）が持っているデータなので、
    // meanji の API を直接叩く。kanatomy 側の DB には words テーブルは無い。
    fetch(`${MEANJI_URL}/api/kanji-words/${encodeURIComponent(kanji)}`)
      .then(r => r.json())
      .then(d => setWords(d.results || []))
      .catch(() => setWords([]));
  }, [kanji]);

  if (!data) return <div>Loading...</div>;

  const hex = kanji.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  const on  = data.on_yomi?.join('、');
  const kun = data.kun_yomi?.join('、');
  const description = `漢字「${kanji}」の情報。Unicode U+${hex}、音読み: ${on || '-'}、訓読み: ${kun || '-'}。`;

  return (
    <div className="details-container">
      <Helmet>
        <title>漢字情報：{kanji}｜kanatomy</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={`漢字情報：${kanji}`} />
        <meta property="og:description" content={description} />
      </Helmet>

      <h2>{kanji}</h2>
      <p>Unicode: U+{hex}</p>
      {on  && <p>音読み: {on}</p>}
      {kun && <p>訓読み: {kun}</p>}

      {data.meanings && (
        <div className="meanings">
          <p>意味:</p>
          <MeaningsList meanings={data.meanings} ordered />
        </div>
      )}

      <PartsTree tree={tree} onPartClick={onPartClick} />

      {similar?.length > 0 && (
        <div className="similar-kanji">
          <p>似ている漢字:</p>
          <ul className="parts-list">
            {similar.map((s, i) => (
              <li
                key={i}
                onClick={() => onPartClick?.(s.character)}
                className="part-item similar-item"
                title={`類似度 ${s.score}点`}
              >
                <span>{s.character}</span>
                <span className="similar-score">{s.score}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {words?.length > 0 && (
        <div className="kanji-words">
          <p>この漢字を使った熟語(meanjiで詳しく見る):</p>
          <ul className="parts-list">
            {words.map((w, i) => (
              <li key={i} className="part-item">
                <a href={`${MEANJI_URL}/word/${encodeURIComponent(w)}`}>{w}</a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
