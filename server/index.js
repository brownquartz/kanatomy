require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// Railwayはプロキシ経由なので、express-rate-limit等がクライアントの実IPを
// 正しく見られるように（無いと全リクエストがプロキシのIP扱いになり、
// レート制限が実質1人分になってしまう）
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false, // SPAの構成上、まずは無効化（必要なら後で個別に設定する）
}));
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

// ─── レート制限 ────────────────────────────────────────────────────────────────
// 全体の緩い上限 + 重い/悪用されやすいエンドポイント用の厳しい上限、の2段構え
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, please try again later' },
});
app.use('/api/', apiLimiter);

// 手書き認識はGoogleの外部APIへのプロキシなので、乱用されるとそのAPI自体が
// ブロックされ、全ユーザーが使えなくなるリスクがある。より厳しく制限する。
const handwritingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, please try again later' },
});

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
  // 部品数に上限を設ける（異体字展開のcartesian積が組み合わせ爆発を起こし、
  // DoS的な負荷をかけられる可能性があるため）
  if (parts.length > 30) {
    return res.status(400).json({ error: 'too many parts' });
  }

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
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
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
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
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
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
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
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  } finally {
    client.release();
  }
});

// ─── 部品ベースの「ほぼ同じ構成」判定 ─────────────────────────────────────────
// 直接部品(layer_index=0)の構成が、対象漢字とちょうど1個だけ異なる漢字を探す
// （例: 仙=[亻,山] に対して、[亻,土]を持つような字）。
//
// 注意: 亻・氵・艹のような超頻出部品だと「1個だけ違う」がほぼ何にでも当てはまって
// しまい(「亻+なにか」が全部ヒットする)ノイズだらけになる。なので、差分になっている
// 部品どうしが視覚的にも近い(=見た目としても本当に間違えそうな)場合だけ採用する。
const STRUCTURAL_VISUAL_THRESHOLD = 75; // 100点満点中。55だと単純な部品はほぼ何でも通ってしまったため
const STRUCTURAL_CANDIDATE_LIMIT = 500; // 超頻出部品での異常な件数に対する安全弁

async function findStructuralNearMatches(client, char) {
  const { rows: selfRows } = await client.query(
    `SELECT parts FROM kanji_patterns WHERE kanji_char = $1 AND layer_index = 0`,
    [char]
  );
  if (!selfRows.length) return [];
  const selfParts = selfRows[0].parts.filter(p => p !== char && p.codePointAt(0) > 0x007F);
  if (selfParts.length < 2) return []; // 部品1個(=単純な字)は比較対象にしない

  // 候補は「読みが判明している(=KANJIDIC2に載っている実在の漢字)」ものだけに絞る。
  // 分解データにしか出てこないような超レアな断片文字（読み無し）は、部品が1個
  // 違うだけで大量にヒットしてしまいノイズになるため対象外にする。
  const { rows } = await client.query(
    `SELECT kp.kanji_char, kp.parts FROM kanji_patterns kp
     JOIN kanji k ON k.character = kp.kanji_char
     WHERE kp.layer_index = 0 AND kp.kanji_char != $1 AND kp.parts && $2::text[]
       AND (k.on_yomi IS NOT NULL OR k.kun_yomi IS NOT NULL)
     LIMIT $3`,
    [char, selfParts, STRUCTURAL_CANDIDATE_LIMIT]
  );

  const selfSet = new Set(selfParts);
  const candidates = []; // { char, diffFrom, diffTo }
  for (const row of rows) {
    const candParts = row.parts.filter(p => p !== row.kanji_char && p.codePointAt(0) > 0x007F);
    if (candParts.length !== selfParts.length) continue; // 部品数が同じ字だけ比較する
    const diffTo = candParts.filter(p => !selfSet.has(p));
    if (diffTo.length !== 1) continue; // ちょうど1個だけ違う（重複部品がある場合は単純化のためスキップ）
    const diffFrom = selfParts.filter(p => !candParts.includes(p));
    if (diffFrom.length !== 1) continue;
    candidates.push({ char: row.kanji_char, diffFrom: diffFrom[0], diffTo: diffTo[0] });
  }
  if (!candidates.length) return [];

  // 差分部品どうしの視覚的な近さを判定する。ペアごとにDB往復すると（候補数が多い
  // 頻出部品では）N+1で非常に遅くなるので、必要な文字のvisual_hashを1クエリで
  // まとめて取得し、ハミング距離はJS側の文字列比較だけで計算する（DB往復なし）。
  const diffChars = [...new Set(candidates.flatMap(c => [c.diffFrom, c.diffTo]))];
  const { rows: hashRows } = await client.query(
    `SELECT character, visual_hash::text AS hash FROM kanji WHERE character = ANY($1)`,
    [diffChars]
  );
  const hashMap = new Map(hashRows.map(r => [r.character, r.hash]));

  function visualScore(a, b) {
    const ha = hashMap.get(a);
    const hb = hashMap.get(b);
    if (!ha || !hb) return 0;
    let dist = 0;
    for (let i = 0; i < ha.length; i++) if (ha[i] !== hb[i]) dist++;
    return 100 * (1 - dist / ha.length);
  }

  const passed = candidates.filter(c => visualScore(c.diffFrom, c.diffTo) >= STRUCTURAL_VISUAL_THRESHOLD);
  if (!passed.length) return [];

  // 常用漢字・使用頻度の高い字を優先する（「読みがある」だけだとCJK拡張領域の
  // 超レアな字も混ざるため、実際によく使われるものを上に出す）
  const { rows: metaRows } = await client.query(
    `SELECT character, is_joyo, frequency FROM kanji WHERE character = ANY($1)`,
    [passed.map(c => c.char)]
  );
  const metaByChar = new Map(metaRows.map(r => [r.character, r]));
  passed.sort((a, b) => {
    const ma = metaByChar.get(a.char) || {};
    const mb = metaByChar.get(b.char) || {};
    if (!!mb.is_joyo !== !!ma.is_joyo) return (mb.is_joyo ? 1 : 0) - (ma.is_joyo ? 1 : 0);
    return (ma.frequency ?? Infinity) - (mb.frequency ?? Infinity);
  });

  return passed.map(c => c.char);
}

// ─── GET /api/kanji/:char/similar ────────────────────────────────────────────
// 「似ている漢字」を2つのシグナルで集めて統合する:
//   1. 見た目(視覚ハッシュ, phash+dhash)が近い順 — 事前計算済みなのでDB側のbit_count(a#b)で瞬時
//   2. 直接部品の構成がちょうど1個だけ違う（部首の見間違い等、確度が非常に高いシグナル）
app.get('/api/kanji/:char/similar', async (req, res) => {
  const char = req.params.char;
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
  const client = await pool.connect();
  try {
    const structural = (await findStructuralNearMatches(client, char)).slice(0, limit);

    const { rows: selfRows } = await client.query(
      `SELECT visual_hash FROM kanji WHERE character = $1`,
      [char]
    );
    let visual = [];
    if (selfRows.length && selfRows[0].visual_hash !== null) {
      const { rows } = await client.query(
        `SELECT character, bit_count(visual_hash # $1::bit(512)) AS distance
         FROM kanji
         WHERE visual_hash IS NOT NULL AND character != $2
         ORDER BY distance ASC
         LIMIT $3`,
        [selfRows[0].visual_hash, char, limit]
      );
      visual = rows.map(r => ({ character: r.character }));
    }

    // 部品構成の一致(確度が高い)を先頭に、重複を除きつつ視覚類似度で埋める
    const seen = new Set();
    const results = [];
    for (const character of structural) {
      if (seen.has(character)) continue;
      seen.add(character);
      results.push({ character });
    }
    for (const r of visual) {
      if (seen.has(r.character) || results.length >= limit) continue;
      seen.add(r.character);
      results.push(r);
    }

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  } finally {
    client.release();
  }
});

// ─── 漢字の親子ツリー構築ヘルパー ─────────────────────────────────────────────
// 「理→[王, 里→[田,土]]」のような素直な親子構造を作る。既存の kanji_patterns の
// 「レイヤーごとに累積展開」データとは別に、各漢字自身の layer_index=0（直接部品）
// だけを再帰的にたどる。1ノードずつ問い合わせるとN+1になるので、深さごとに
// まとめて取得するBFSにしている（深い漢字でも数クエリで済む）。
async function fetchDirectPartsTree(client, rootChar, maxDepth = 12) {
  const directParts = new Map(); // char -> string[]（自分自身を除くHan文字の直接部品）
  let frontier = [rootChar];
  const seen = new Set(frontier);

  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const { rows } = await client.query(
      `SELECT kanji_char, parts FROM kanji_patterns WHERE kanji_char = ANY($1) AND layer_index = 0`,
      [frontier]
    );
    const next = [];
    for (const row of rows) {
      const parts = row.parts.filter(p => p !== row.kanji_char && p.codePointAt(0) > 0x007F);
      directParts.set(row.kanji_char, parts);
      for (const p of parts) {
        if (!seen.has(p)) { seen.add(p); next.push(p); }
      }
    }
    frontier = next;
  }

  // 循環参照ガード付きでツリーに組み立てる
  function build(char, ancestors) {
    if (ancestors.has(char)) return { character: char, parts: [] };
    const parts = directParts.get(char) || [];
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(char);
    return { character: char, parts: parts.map(p => build(p, nextAncestors)) };
  }
  return build(rootChar, new Set());
}

// ─── GET /api/kanji/:char/tree ────────────────────────────────────────────────
// 「似ている漢字への差し替え」等とは別の、素直な親子分解ツリー表示用API。
app.get('/api/kanji/:char/tree', async (req, res) => {
  const char = req.params.char;
  const client = await pool.connect();
  try {
    const tree = await fetchDirectPartsTree(client, char);
    res.json({ tree });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  } finally {
    client.release();
  }
});

// ─── Feature 4: POST /api/handwriting ────────────────────────────────────────
// body: { ink, width, height }
app.post('/api/handwriting', handwritingLimiter, async (req, res) => {
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
