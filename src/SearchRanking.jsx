import { useState, useEffect } from 'react';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

const PERIODS = [
  { label: '今日', value: 'day' },
  { label: '今週', value: 'week' },
  { label: '今月', value: 'month' },
];

export default function SearchRanking({ onKanjiClick }) {
  const [period, setPeriod] = useState('day');
  const [ranking, setRanking] = useState([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/ranking?period=${period}&limit=10`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setRanking(data.ranking || []);
      })
      .catch((err) => {
        console.error('Failed to fetch ranking:', err);
        if (!cancelled) setRanking([]);
      });
    return () => { cancelled = true; };
  }, [period]);

  return (
    <div className="ranking-section">
      <div className="ranking-tabs">
        {PERIODS.map(({ label, value }) => (
          <button
            key={value}
            className={period === value ? 'active' : ''}
            onClick={() => setPeriod(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {ranking.length === 0 ? (
        <p>データなし</p>
      ) : (
        <ol className="ranking-list">
          {ranking.map((item, index) => (
            <li
              key={index}
              className="ranking-item"
              onClick={() => onKanjiClick(item.query)}
            >
              <span className="ranking-num">{index + 1}</span>
              <span className="ranking-char">{item.query}</span>
              <span className="ranking-count">{item.count}回</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
