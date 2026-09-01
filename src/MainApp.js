// src/MainApp.js
import React, { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import HandwritingCanvas from './HandwritingCanvas';
import SearchRanking from './SearchRanking';
import './MainApp.css';

const API_URL = process.env.REACT_APP_API_URL ?? 'http://localhost:4000';
// meanji（辞書サイト、別リポジトリ/別デプロイ）への外部リンク。kanatomy はこの先の
// データ・コードには一切依存しない（一方向のリンクのみ）。
const MEANJI_URL = process.env.REACT_APP_MEANJI_URL ?? 'http://localhost:4001';

// 検索結果から漢字詳細ページに移動→ブラウザで戻った時、検索語・結果を保持しておくための
// sessionStorage キー。MainApp は "/kanji/:char" への遷移で一旦アンマウントされるため、
// 通常のReact state だけでは戻った時に消えてしまう。
const STORAGE_KEY = 'kanatomy:searchState';
function loadSavedState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function MainApp() {
  const navigate = useNavigate();
  const saved = loadSavedState();

  const [inputValue, setInputValue] = useState(saved?.inputValue ?? '');
  const [searchTerm, setSearchTerm] = useState(saved?.searchTerm ?? '');
  const [mode, setMode] = useState(saved?.mode ?? 'partsToKanji');
  const [region, setRegion] = useState(saved?.region ?? 'joyo');
  const [results, setResults] = useState(saved?.results ?? []);
  const [page, setPage] = useState(saved?.page ?? 1);
  const [loading, setLoading] = useState(false);
  const MAX_DISPLAY = 100;

  // 引き算モード
  const [subMinuend, setSubMinuend] = useState(saved?.subMinuend ?? '');
  const [subSubtrahend, setSubSubtrahend] = useState(saved?.subSubtrahend ?? '');
  const [subRemainingParts, setSubRemainingParts] = useState(saved?.subRemainingParts ?? []);

  // 検索に関わる状態が変わるたびに保存しておく（結果ページへの遷移→戻る、で復元するため）
  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        inputValue, searchTerm, mode, region, results, page,
        subMinuend, subSubtrahend, subRemainingParts,
      }));
    } catch {
      // sessionStorageが使えない環境でも致命的ではないので無視
    }
  }, [inputValue, searchTerm, mode, region, results, page, subMinuend, subSubtrahend, subRemainingParts]);

  const doSearch = useCallback(async (term, currentMode, currentRegion) => {
    if (!term) { setResults([]); return; }
    const rawParts = Array.from(term).filter(ch => /\p{Script=Han}/u.test(ch));
    if (!rawParts.length) { setResults([]); return; }

    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: rawParts, mode: currentMode, region: currentRegion }),
      });
      const data = await res.json();
      setResults(data.results || []);
      setPage(1);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const doSubtract = useCallback(async (minuend, subtrahend, currentRegion) => {
    if (!minuend || !subtrahend) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/search/subtract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minuend, subtrahend, region: currentRegion }),
      });
      const data = await res.json();
      setResults(data.results || []);
      setSubRemainingParts(data.remainingParts || []);
      setPage(1);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSearch = () => {
    const term = inputValue.trim();
    setSearchTerm(term);
    doSearch(term, mode, region);
  };

  const handleKeyDown = e => { if (e.key === 'Enter') handleSearch(); };

  const handleModeChange = (newMode) => {
    setMode(newMode);
    setResults([]);
    setSearchTerm('');
    setSubRemainingParts([]);
  };

  const handleRegionChange = (newRegion) => {
    setRegion(newRegion);
    if (searchTerm) doSearch(searchTerm, mode, newRegion);
  };

  const handleHandwritingRecognize = (candidates) => {
    // 手書きは1文字ずつの検索にしたいので、単一の漢字候補のみ残す
    // （熟語などの複数文字候補は除外。候補が複数出るのはそのままでよい）
    setResults(candidates.filter(c => Array.from(c).length === 1 && /\p{Script=Han}/u.test(c)));
    setPage(1);
  };

  const visible = results.slice(0, page * MAX_DISPLAY);
  const moreCount = results.length - visible.length;

  const tooltipText = {
    partsToKanji: `入力部品を組み立てて、\n一番近い漢字を出力します。\nex) "口口口" ⇒ "品臨器操燥繰藻"\n    "水也" ⇒ "池"\n    "角刀牛" ⇒ "解"`,
    kanjiToParts: `漢字を複数層で分けて、\n全要素を重複なしで出力します。\nex) "嘔" ⇒ "口區匸品"\n"池" ⇒ "氵也"\n"解" ⇒ "刀牛角丿𠃌"`,
    subtract: `漢字から部品を引いて、\n残りの部品を持つ漢字を探します。\nex) "汲 − 氵" ⇒ "及"\n    "解 − 角" ⇒ "判"`,
    handwriting: `キャンバスに漢字を書いて認識します。\n認識結果をクリックすると詳細を表示。`,
  };

  return (
    <div className="app-container">
      {loading && (
        <div className="loading-overlay">
          <div className="loading-bar" />
        </div>
      )}

      <h1 className="header">
        漢字分解・組み立て検索
        <span className={`info-icon ${mode}`}>ⓘ
          <div className="tooltip">{tooltipText[mode]}</div>
        </span>
      </h1>

      <p style={{ textAlign: 'center', marginTop: '-0.5rem', marginBottom: '1.5rem' }}>
        <a href={MEANJI_URL}>単語（表記・読み）から検索する →</a>
      </p>

      <div className="controls">
        <div className="modes">
          <button className={mode === 'partsToKanji' ? 'active' : ''} onClick={() => handleModeChange('partsToKanji')}>部品→漢字</button>
          <button className={mode === 'kanjiToParts' ? 'active' : ''} onClick={() => handleModeChange('kanjiToParts')}>漢字→部品</button>
          <button className={mode === 'subtract' ? 'active' : ''} onClick={() => handleModeChange('subtract')}>引き算</button>
          <button className={mode === 'handwriting' ? 'active' : ''} onClick={() => handleModeChange('handwriting')}>手書き</button>
        </div>

        {(mode === 'partsToKanji' || mode === 'kanjiToParts') && (
          <>
            {mode === 'partsToKanji' && (
              <div className="region-filter">
                <button className={region === 'joyo' ? 'active' : ''} onClick={() => handleRegionChange('joyo')}>常用漢字</button>
                <button className={region === 'japanese' ? 'active' : ''} onClick={() => handleRegionChange('japanese')}>+表外漢字</button>
                <button className={region === 'chinese' ? 'active' : ''} onClick={() => handleRegionChange('chinese')}>+中国漢字</button>
              </div>
            )}
            <div className="search-section">
              <div className="search-box">
                <input
                  className="search-input"
                  placeholder={mode === 'partsToKanji' ? '部品入力' : '漢字入力'}
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
                <button className="search-button" onClick={handleSearch}>検索</button>
              </div>
              {searchTerm && <div className="search-info">検索ワード：{searchTerm}</div>}
            </div>
          </>
        )}

        {mode === 'subtract' && (
          <div className="subtract-section">
            <div className="region-filter">
              <button className={region === 'joyo' ? 'active' : ''} onClick={() => setRegion('joyo')}>常用漢字</button>
              <button className={region === 'japanese' ? 'active' : ''} onClick={() => setRegion('japanese')}>+表外漢字</button>
              <button className={region === 'chinese' ? 'active' : ''} onClick={() => setRegion('chinese')}>+中国漢字</button>
            </div>
            <div className="subtract-box">
              <input
                className="search-input subtract-input"
                placeholder="漢字"
                value={subMinuend}
                onChange={e => setSubMinuend(e.target.value)}
                maxLength={1}
              />
              <span className="subtract-op">−</span>
              <input
                className="search-input subtract-input"
                placeholder="引く部品"
                value={subSubtrahend}
                onChange={e => setSubSubtrahend(e.target.value)}
              />
              <span className="subtract-op">=</span>
              {subRemainingParts.length > 0 && (
                <span className="subtract-remaining">{subRemainingParts.join(' ')}</span>
              )}
              <button className="search-button" onClick={() => doSubtract(subMinuend.trim(), subSubtrahend.trim(), region)}>計算</button>
            </div>
          </div>
        )}

        {mode === 'handwriting' && (
          <HandwritingCanvas onRecognize={handleHandwritingRecognize} />
        )}
      </div>

      {/* 結果一覧（手書きも含む） */}
      <div className="result-section">
        <ul className="result-list">
          {visible.length > 0 ? (
            visible.map((k, i) => (
              <li key={i} onClick={() => navigate(`/kanji/${encodeURIComponent(k)}`)}>{k}</li>
            ))
          ) : (
            <li className="no-data">
              {(searchTerm || (mode === 'subtract' && subMinuend) || mode === 'handwriting') ? 'X' : '.'}
            </li>
          )}
        </ul>
        {moreCount > 0 && (
          <button className="more-button" onClick={() => setPage(p => p + 1)}>
            その他（{moreCount}件）
          </button>
        )}
      </div>

      <SearchRanking onKanjiClick={(q) => {
        handleModeChange('partsToKanji');
        setInputValue(q);
        setSearchTerm(q);
        doSearch(q, 'partsToKanji', region);
      }} />
    </div>
  );
}
