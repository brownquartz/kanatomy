require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// TODO: 独自ドメインを設定したら、そのURLも追加する
const allowedOrigins = [
  'https://kanatomy-production.up.railway.app',
  'http://localhost:3000',
];
app.use(cors({
  origin: (origin, callback) => {
    // origin が undefined = サーバー間リクエスト（curl等）は許可
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy violation'));
    }
  },
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Feature 7: search_logs テーブルを起動時に自動作成 ──────────────────────────
(async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS search_logs (
        id        BIGSERIAL PRIMARY KEY,
        query     TEXT NOT NULL,
        mode      TEXT,
        region    TEXT,
        logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('search_logs table ready');
  } catch (err) {
    console.error('Failed to create search_logs table:', err.message);
  } finally {
    client.release();
  }
})();

// ─── ヘルスチェック ────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ─── 異体字を含む部品リストを展開するヘルパー ──────────────────────────────────
async function expandWithVariants(client, parts) {
  if (!parts.length) return [];
  const { rows } = await client.query(
    `SELECT base_char, variant_char FROM kanji_variants
     WHERE base_char = ANY($1) OR variant_char = ANY($1)`,
    [parts]
  );
  // 各部品ごとに自身 + 異体字をまとめた配列を作る
  const variantMap = {};
  for (const p of parts) variantMap[p] = [p];
  for (const { base_char, variant_char } of rows) {
    if (parts.includes(base_char) && !variantMap[base_char].includes(variant_char)) {
      variantMap[base_char].push(variant_char);
    }
    if (parts.includes(variant_char) && !variantMap[variant_char].includes(base_char)) {
      variantMap[variant_char].push(base_char);
    }
  }
  return parts.map(p => variantMap[p]);
}

// ─── Feature 8: calcScore ヘルパー ────────────────────────────────────────────
// patternParts: DB から取得した漢字のパーツ配列（row.parts。重複あり得る）
// inputParts:   ユーザーが入力した検索パーツ配列（重複あり得る。例: 品→"口口口"）
//
// recall（要求した部品をどれだけ満たせたか）を主軸に、precision（候補が要求部品
// 以外の余計な部品でどれだけ埋まっていないか）と順序ボーナスを加える。
// 以前は precision 相当の値だけを見ていたため、候補側の部品数が少ないだけで
// スコアが不当に高くなり（要求部品を一部しか満たしていなくても100%扱いになる）、
// 並び順がおかしく見える原因になっていた。
function calcScore(patternParts, inputParts) {
  const kanjiParts = patternParts.filter(p => p.codePointAt(0) > 0x007F);
  const total = kanjiParts.length;
  if (!total || !inputParts.length) return 0;

  const inputCnt = {};
  inputParts.forEach(p => (inputCnt[p] = (inputCnt[p] || 0) + 1));
  const candCnt = {};
  kanjiParts.forEach(p => (candCnt[p] = (candCnt[p] || 0) + 1));

  let match = 0;
  Object.entries(inputCnt).forEach(([p, n]) => {
    match += Math.min(n, candCnt[p] || 0);
  });

  const recall = match / inputParts.length; // 要求部品をどれだけ満たしたか（最重要）
  const precision = match / total;          // 候補が要求部品でどれだけ占められているか

  // order bonus: inputParts が patternParts の部分列（subsequence）として現れるか確認
  let ptr = 0;
  let orderMatched = 0;
  for (const pp of patternParts) {
    if (ptr < inputParts.length && pp === inputParts[ptr]) {
      orderMatched++;
      ptr++;
    }
  }
  const orderBonus = (orderMatched / inputParts.length) * 10;

  return recall * 70 + precision * 30 + orderBonus;
}

// ─── 指定した部品（重複可）を"すべて"含む漢字の候補集合を求めるヘルパー ─────────
// 部品ごとに異体字も同一視して探す。kanji_parts は (kanji_char, part_char) の
// 重複無しペアなので、まずは種類（重複除去）ベースで「すべての種類を含む」候補を
// 絞り込む。実際の必要個数（例: 口が3個）を満たしているかは、呼び出し側で
// kanji_patterns の実データ（重複を保持した配列）を見て calcScore 側で判定する。
async function findCandidatesContainingParts(client, parts) {
  const uniqueParts = [...new Set(parts)];
  const variantArrays = await expandWithVariants(client, uniqueParts);

  const cartesian = arrays =>
    arrays.reduce((acc, curr) => acc.flatMap(a => curr.map(b => [...a, b])), [[]]);
  const combos = cartesian(variantArrays);

  const candidates = new Set();
  for (const combo of combos) {
    const { rows } = await client.query(
      `SELECT kanji_char FROM kanji_parts
       WHERE part_char = ANY($1)
       GROUP BY kanji_char
       HAVING COUNT(DISTINCT part_char) = $2`,
      [combo, combo.length]
    );
    for (const { kanji_char } of rows) candidates.add(kanji_char);
  }
  return candidates;
}

// ─── 候補群の kanji_patterns を1回のクエリでまとめて取得し、calcScore で
// 最良層のスコアを付けて上位順にソートする。
// スコアが同点の場合、レアな異体字よりも常用漢字・使用頻度の高い字を優先する
// タイブレークを入れる（そうしないと稀にしか使われない字が先頭に来てしまう）。
async function scoreCandidates(client, candidates, inputParts, limit = 100) {
  if (!candidates.length) return [];
  const [{ rows: patternRows }, { rows: metaRows }] = await Promise.all([
    client.query(`SELECT kanji_char, parts FROM kanji_patterns WHERE kanji_char = ANY($1)`, [candidates]),
    client.query(`SELECT character, is_joyo, frequency FROM kanji WHERE character = ANY($1)`, [candidates]),
  ]);
  const byChar = new Map();
  for (const row of patternRows) {
    if (!byChar.has(row.kanji_char)) byChar.set(row.kanji_char, []);
    byChar.get(row.kanji_char).push(row.parts);
  }
  const metaByChar = new Map(metaRows.map(r => [r.character, r]));

  const scored = candidates.map(k => {
    const layers = byChar.get(k) || [];
    const score = layers.reduce((best, parts) => Math.max(best, calcScore(parts, inputParts)), 0);
    const meta = metaByChar.get(k);
    return {
      k,
      score,
      isJoyo: meta?.is_joyo ? 1 : 0,
      // frequency は数値が小さいほど頻出（KANJIDIC2の定義）。無い場合は最下位扱い。
      frequency: meta?.frequency ?? Infinity,
    };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.isJoyo !== a.isJoyo) return b.isJoyo - a.isJoyo;
    return a.frequency - b.frequency;
  });

  return scored.slice(0, limit).map(o => o.k);
}

// ─── POST /api/search ─────────────────────────────────────────────────────────
// body: { parts: string[], mode: 'partsToKanji' | 'kanjiToParts', region: 'joyo' | 'japanese' | 'chinese' }
app.post('/api/search', async (req, res) => {
  const { parts, mode, region } = req.body;
  if (!parts?.length) return res.json({ results: [] });

  // Feature 7: 検索ログを記録（fire-and-forget）
  const query = parts.join('');
  pool.query(
    `INSERT INTO search_logs (query, mode, region) VALUES ($1, $2, $3)`,
    [query, mode ?? null, region ?? null]
  ).catch(err => console.error('search_logs insert error:', err.message));

  const client = await pool.connect();
  try {
    // ── 漢字→部品 ──────────────────────────────────────────────────────────────
    if (mode === 'kanjiToParts') {
      const kanji = parts[0];
      const { rows } = await client.query(
        `SELECT layer_index, parts FROM kanji_patterns
         WHERE kanji_char = $1
         ORDER BY layer_index`,
        [kanji]
      );
      const seen = new Set();
      const out = [];
      for (const row of rows) {
        for (const p of row.parts) {
          if (p.codePointAt(0) > 0x007F && !seen.has(p)) {
            seen.add(p);
            out.push(p);
          }
        }
      }
      return res.json({ results: out });
    }

    // ── 部品→漢字（単一部品）────────────────────────────────────────────────────
    if (parts.length === 1) {
      const variantArrays = await expandWithVariants(client, parts);
      const allParts = variantArrays.flat();

      let query = `
        SELECT DISTINCT kp.kanji_char
        FROM kanji_parts kp
        JOIN kanji k ON k.character = kp.kanji_char
        WHERE kp.part_char = ANY($1)
      `;
      const params = [allParts];

      if (region === 'joyo') {
        query += ` AND k.is_joyo = true`;
      } else if (region === 'japanese') {
        query += ` AND (k.is_joyo = true OR k.is_japanese = true)`;
      }

      const { rows } = await client.query(query, params);
      // 自身を先頭に
      const results = rows.map(r => r.kanji_char);
      const self = parts[0];
      const deduped = [self, ...results.filter(k => k !== self)];
      return res.json({ results: deduped });
    }

    // ── 部品→漢字（複数部品）────────────────────────────────────────────────────
    const candidateSet = await findCandidatesContainingParts(client, parts);

    // region フィルター
    let candidates = [...candidateSet];
    if (region !== 'chinese') {
      const { rows: kanjiRows } = await client.query(
        `SELECT character FROM kanji
         WHERE character = ANY($1) AND ${region === 'joyo' ? 'is_joyo = true' : '(is_joyo = true OR is_japanese = true)'}`,
        [candidates]
      );
      const allowed = new Set(kanjiRows.map(r => r.character));
      candidates = candidates.filter(k => allowed.has(k));
    }

    // Feature 8: calcScore でスコア計算し上位100件にソート（重複部品の必要数も考慮）
    const results = await scoreCandidates(client, candidates, parts, 100);
    return res.json({ results });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── Feature 7: GET /api/ranking ──────────────────────────────────────────────
// ?period=day|week|month&limit=10
app.get('/api/ranking', async (req, res) => {
  const { period = 'day', limit = '10' } = req.query;

  // 安全なマッピング（文字列補間は使わない）
  const intervalMap = {
    day:   '1 day',
    week:  '7 days',
    month: '30 days',
  };
  const intervalStr = intervalMap[period] ?? '1 day';
  const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));

  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT query, COUNT(*) AS count
       FROM search_logs
       WHERE logged_at >= NOW() - $1::INTERVAL
       GROUP BY query
       ORDER BY count DESC
       LIMIT $2`,
      [intervalStr, limitNum]
    );
    res.json({ period, limit: limitNum, ranking: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── Feature 5: POST /api/search/subtract ────────────────────────────────────
// body: { minuend: '汲', subtrahend: '氵', region: 'joyo' }
app.post('/api/search/subtract', async (req, res) => {
  const { minuend, subtrahend, region } = req.body;
  if (!minuend || !subtrahend) {
    return res.status(400).json({ error: 'minuend and subtrahend are required' });
  }

  const client = await pool.connect();
  try {
    // minuend の直接部品（layer_index=0）を取得
    const { rows: patternRows } = await client.query(
      `SELECT parts FROM kanji_patterns
       WHERE kanji_char = $1 AND layer_index = 0`,
      [minuend]
    );

    if (!patternRows.length) {
      return res.json({ results: [], remainingParts: [] });
    }

    // 漢字文字のみ抽出
    const directParts = patternRows[0].parts.filter(
      p => p.codePointAt(0) > 0x007F
    );

    // subtrahend を1回除去（異体字も同一部品とみなす）
    const remaining = [...directParts];
    const [subtrahendVariants] = await expandWithVariants(client, [subtrahend]);
    const subIdx = remaining.findIndex(p => subtrahendVariants.includes(p));
    if (subIdx !== -1) {
      remaining.splice(subIdx, 1);
    }

    if (!remaining.length) {
      return res.json({ results: [], remainingParts: remaining });
    }

    // 残った部品を「含む」漢字を広く集める（候補プール）
    const candidateSet = await findCandidatesContainingParts(client, remaining);
    let candidates = [...candidateSet];
    // 残り部品が1つだけの場合、その部品自体も候補に含める（例: 仙-人 → 山 自体が答え）
    if (remaining.length === 1 && !candidates.includes(remaining[0])) {
      candidates.push(remaining[0]);
    }

    if (region && region !== 'chinese') {
      const { rows: kanjiRows } = await client.query(
        `SELECT character FROM kanji
         WHERE character = ANY($1) AND ${region === 'joyo' ? 'is_joyo = true' : '(is_joyo = true OR is_japanese = true)'}`,
        [candidates]
      );
      const allowed = new Set(kanjiRows.map(r => r.character));
      candidates = candidates.filter(k => allowed.has(k));
    }

    // 「含む」候補プールから、直接部品（layer_index=0）が remaining と
    // ちょうど一致する漢字だけに絞り込む（＝厳密な引き算結果）。個数（多重度）も
    // 見る必要がある（例: remaining=[口,口] のとき、口が1個の漢字は不一致）。
    // 候補ごとに逐次クエリすると遅いので、1回のクエリでまとめて取得する。
    const remainingCnt = {};
    remaining.forEach(p => (remainingCnt[p] = (remainingCnt[p] || 0) + 1));
    const remainingTotal = remaining.length;

    const { rows: patternsForCandidates } = candidates.length
      ? await client.query(
          `SELECT kanji_char, parts FROM kanji_patterns WHERE kanji_char = ANY($1) AND layer_index = 0`,
          [candidates]
        )
      : { rows: [] };
    const patternMap = new Map(patternsForCandidates.map(r => [r.kanji_char, r.parts]));

    const exactMatches = [];
    for (const k of candidates) {
      if (remaining.length === 1 && k === remaining[0]) {
        exactMatches.push(k);
        continue;
      }
      const parts = patternMap.get(k);
      if (!parts) continue;
      const kParts = parts.filter(p => p.codePointAt(0) > 0x007F);
      if (kParts.length !== remainingTotal) continue;
      const kCnt = {};
      kParts.forEach(p => (kCnt[p] = (kCnt[p] || 0) + 1));
      const isExact = Object.entries(remainingCnt).every(([p, n]) => kCnt[p] === n);
      if (isExact) exactMatches.push(k);
    }

    return res.json({ results: exactMatches, remainingParts: remaining });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── GET /api/kanji/:char ─────────────────────────────────────────────────────
// 「この漢字を使った熟語」は meanji（別サービス）が持つデータなので、ここでは返さない。
// フロント側で meanji の API を直接叩く。
app.get('/api/kanji/:char', async (req, res) => {
  const char = req.params.char;
  const client = await pool.connect();
  try {
    // visual_hash(512bit)はこのAPIでは不要（レスポンスが無駄に大きくなる）ので除外
    const [kanjiRes, partsRes] = await Promise.all([
      client.query(
        `SELECT character, unicode_point, is_joyo, is_japanese, on_yomi, kun_yomi,
                example_yomi, stroke_count, jlpt_level, grade, frequency, radical, meanings
         FROM kanji WHERE character = $1`,
        [char]
      ),
      client.query(`SELECT part_char FROM kanji_parts WHERE kanji_char = $1`, [char]),
    ]);
    if (!kanjiRes.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({
      ...kanjiRes.rows[0],
      parts: partsRes.rows.map(r => r.part_char),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── GET /api/kanji/:char/similar ────────────────────────────────────────────
// 見た目が似ている漢字を、事前計算済みの視覚ハッシュ(phash+dhash, 計512bit)の
// ハミング距離が近い順に返す。距離はDB側の bit_count(a # b) で計算する
// （XORで異なるビットを数えるだけなので、対象規模なら全件スキャンでも十分速い）。
app.get('/api/kanji/:char/similar', async (req, res) => {
  const char = req.params.char;
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
  const client = await pool.connect();
  try {
    const { rows: selfRows } = await client.query(
      `SELECT visual_hash FROM kanji WHERE character = $1`,
      [char]
    );
    if (!selfRows.length || selfRows[0].visual_hash === null) {
      return res.json({ results: [] });
    }
    const { rows } = await client.query(
      `SELECT character, bit_count(visual_hash # $1::bit(512)) AS distance
       FROM kanji
       WHERE visual_hash IS NOT NULL AND character != $2
       ORDER BY distance ASC
       LIMIT $3`,
      [selfRows[0].visual_hash, char, limit]
    );
    const results = rows.map(r => ({
      character: r.character,
      score: Math.round(100 * (1 - r.distance / 512) * 10) / 10,
    }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── Feature 4: POST /api/handwriting ────────────────────────────────────────
// body: { ink, width, height }
app.post('/api/handwriting', async (req, res) => {
  const { ink, width, height } = req.body;
  if (!ink) return res.status(400).json({ error: 'ink is required' });

  const payload = {
    app_version: 0.1,
    api_level: 'rc',
    options: 'enable_pre_space',
    requests: [
      {
        writing_guide: {
          writing_area_width: width,
          writing_area_height: height,
        },
        ink,
        language: 'ja',
        pre_context: '',
        n_best_size: 7,
        auto_commit_n_best_size: 7,
      },
    ],
  };

  try {
    const response = await fetch(
      'https://inputtools.google.com/request?itc=ja-t-i0-handwrit&num=7',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const data = await response.json();
    const candidates = data?.[1]?.[0]?.[1] ?? [];
    res.json({ candidates });
  } catch (err) {
    console.error('handwriting proxy error:', err.message);
    res.status(502).json({ error: 'handwriting service unavailable' });
  }
});

// ─── Feature 6: GET /sitemap.xml（express.static の前に配置）─────────────────
app.get('/sitemap.xml', async (req, res) => {
  // TODO: 独自ドメインを設定したら差し替える
  const rootUrl = 'https://kanatomy-production.up.railway.app';
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT character FROM kanji WHERE is_joyo = true ORDER BY character`
    );

    const urls = [
      `  <url><loc>${rootUrl}/</loc></url>`,
      ...rows.map(r => `  <url><loc>${rootUrl}/kanji/${encodeURIComponent(r.character)}</loc></url>`),
    ].join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

    res.setHeader('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    console.error('sitemap error:', err.message);
    res.status(500).send('<?xml version="1.0"?><error/>');
  } finally {
    client.release();
  }
});

// ─── React 静的ファイル配信 ───────────────────────────────────────────────────
const buildPath = path.join(__dirname, '../build');
app.use(express.static(buildPath));
app.use((req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 API server running on port ${PORT}`));
