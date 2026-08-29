// src/KanjiPage.js
import React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import DetailsPage from './DetailsPage';

export default function KanjiPage() {
  const { char } = useParams();
  const navigate = useNavigate();
  return (
    <div className="app-container">
      <button className="search-button" onClick={() => navigate(-1)}>
        ← 検索一覧へ戻る
      </button>
      <DetailsPage
        kanji={char}
        onPartClick={(p) => navigate(`/kanji/${encodeURIComponent(p)}`)}
      />
    </div>
  );
}
