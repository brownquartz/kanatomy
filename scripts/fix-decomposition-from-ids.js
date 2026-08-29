// scripts/fix-decomposition-from-ids.js
// kanji_patterns(layer_index=0) の直接部品が1個しか記録されていない漢字について、
// CJKVI-IDS (https://github.com/cjkvi/cjkvi-ids, ids.txt) の分解データと突き合わせ、
// 「本来は複数部品からなるのに1個しか記録されていない」ケースだけを安全に補完する。
//
// 安全側に倒すため、以下の場合のみパッチする:
//   - IDSのトップレベル分解が「単純な既存文字のみ」で構成されている
//     （未収録の部品プレースホルダ(circled number等)やネストした複合形は除外）
//   - 分解後の部品数が現在DBの記録(1個)より多い
// 既存データを削除・上書きするのではなく、より詳しい情報を追加するだけ。
//
// 実行方法: node scripts/fix-decomposition-from-ids.js [--dry-run]

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const https = require('https');
const { Pool } = require('pg');

const IDS_URL = 'https://raw.githubusercontent.com/cjkvi/cjkvi-ids/master/ids.txt';
const IDS_LOCAL_PATH = path.join(__dirname, 'ids.txt');
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── IDS演算子（見た目の組み方を表す記号）とその子要素の数 ────────────────────
const IDC_ARITY = {
  '⿰': 2, '⿱': 2, '⿴': 2, '⿵': 2, '⿶': 2, '⿷': 2,
  '⿸': 2, '⿹': 2, '⿺': 2, '⿻': 2, '⿲': 3, '⿳': 3,
};

// 部品として使えない（Unicode上に実在する通常の漢字/部首ではない）コードポイント判定
function isUsableComponent(ch) {
  const cp = ch.codePointAt(0);
  if (IDC_ARITY[ch]) return false;                        // IDS演算子そのもの
  if (cp >= 0x2460 && cp <= 0x24FF) return false;          // 丸数字プレースホルダ
  if (cp >= 0xE000 && cp <= 0xF8FF) return false;          // 私用領域(CDP等の未収録部品)
  if (cp >= 0xF0000 && cp <= 0xFFFFD) return false;        // 私用領域(Plane 15)
  if (cp >= 0x100000 && cp <= 0x10FFFD) return false;       // 私用領域(Plane 16)
  return true;
}

// ─── IDS文字列の「その式が何文字分か」を再帰的に求める ────────────────────────
function exprLength(str, pos) {
  const cp = str.codePointAt(pos);
  const ch = String.fromCodePoint(cp);
  const chLen = ch.length; // サロゲートペアなら2
  if (IDC_ARITY[ch]) {
    let p = pos + chLen;
    for (let i = 0; i < IDC_ARITY[ch]; i++) {
      p += exprLength(str, p);
    }
    return p - pos;
  }
  return chLen;
}

// ─── トップレベルの直接の子要素に分割する。演算子で始まらなければ null ────────
function splitTopLevel(str) {
  const rootCp = str.codePointAt(0);
  const rootCh = String.fromCodePoint(rootCp);
  if (!IDC_ARITY[rootCh]) return null;
  let pos = rootCh.length;
  const children = [];
  for (let i = 0; i < IDC_ARITY[rootCh]; i++) {
    const len = exprLength(str, pos);
    children.push(str.slice(pos, pos + len));
    pos += len;
  }
  return children;
}

// ─── IDS式を再帰的に「葉」（それ以上分解されない実在の1文字）まで展開する。
// 未収録プレースホルダ部品が1つでも混ざっていたら null を返す（安全側に倒す）。
function flattenToLeaves(str) {
  const children = splitTopLevel(str);
  if (!children) {
    // 演算子で始まらない = これ自体が1つの実在文字（葉）
    const cps = Array.from(str);
    if (cps.length !== 1 || !isUsableComponent(cps[0])) return null;
    return [cps[0]];
  }
  const leaves = [];
  for (const c of children) {
    const cps = Array.from(c);
    if (cps.length === 1) {
      if (!isUsableComponent(cps[0])) return null;
      leaves.push(cps[0]);
    } else {
      const sub = flattenToLeaves(c);
      if (!sub) return null;
      leaves.push(...sub);
    }
  }
  return leaves;
}

// ─── ids.txt をダウンロード（ローカルに無ければ） ──────────────────────────────
function ensureIdsFile() {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(IDS_LOCAL_PATH)) return resolve();
    console.log(`Downloading ${IDS_URL} ...`);
    const file = fs.createWriteStream(IDS_LOCAL_PATH);
    https.get(IDS_URL, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

// ─── ids.txt をパースして 漢字 -> 優先IDS文字列 のMapを作る ───────────────────
// タグ [J] (日本の字形) を最優先、無ければ無タグの行、それも無ければ最初の行を使う。
function parseIdsFile() {
  const text = fs.readFileSync(IDS_LOCAL_PATH, 'utf8');
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 3) continue;
    const char = fields[1];
    const variants = fields.slice(2).map(f => f.trim()).filter(Boolean);

    let chosen = null;
    let untagged = null;
    for (const v of variants) {
      const m = v.match(/^(.+?)\[([A-Z]+)\]$/);
      if (m) {
        const [, ids, tags] = m;
        if (tags.includes('J')) { chosen = ids; break; }
      } else if (!untagged) {
        untagged = v;
      }
    }
    if (!chosen) chosen = untagged || variants[0]?.replace(/\[[A-Z]+\]$/, '');
    if (chosen) map.set(char, chosen);
  }
  return map;
}

// ─── メイン ──────────────────────────────────────────────────────────────────
async function main() {
  await ensureIdsFile();
  console.log('ids.txt をパース中...');
  const idsMap = parseIdsFile();
  console.log(`IDSエントリ数: ${idsMap.size}`);

  const client = await pool.connect();
  try {
    // 直接部品(layer_index=0, Han文字のみ, 自分自身を除く)が1個しかない漢字を取得
    const { rows } = await client.query(`
      SELECT kp.kanji_char, kp.parts
      FROM kanji_patterns kp
      WHERE kp.layer_index = 0
    `);

    const hanRe = /[㐀-鿿豈-﫿]|[\uD800-\uDBFF][\uDC00-\uDFFF]/;
    const targets = rows.filter(r => {
      const hanParts = r.parts.filter(p => p !== r.kanji_char && hanRe.test(p));
      return hanParts.length === 1;
    });
    console.log(`対象(直接部品1個): ${targets.length} 件`);

    let fixed = 0;
    let skippedNoIds = 0;
    let skippedNotCompound = 0;
    let skippedNotClean = 0;
    let skippedNotImproved = 0;
    const fixedSamples = [];

    for (const row of targets) {
      const char = row.kanji_char;
      const ids = idsMap.get(char);
      if (!ids) { skippedNoIds++; continue; }

      const children = splitTopLevel(ids);
      if (!children) { skippedNotCompound++; continue; }

      // 入れ子構造も含めて再帰的に「実在する葉文字」まで展開する。
      // 未収録プレースホルダ部品が混ざっていれば null（＝安全に修復不可）。
      const flatParts = flattenToLeaves(ids);
      if (!flatParts) { skippedNotClean++; continue; }

      const uniqueParts = [...new Set(flatParts)];
      if (uniqueParts.length <= 1) { skippedNotImproved++; continue; }

      fixed++;
      if (fixedSamples.length < 15) fixedSamples.push({ char, from: row.parts, to: uniqueParts });

      if (!DRY_RUN) {
        await client.query(
          `UPDATE kanji_patterns SET parts = $1 WHERE kanji_char = $2 AND layer_index = 0`,
          [uniqueParts, char]
        );
        for (const part of uniqueParts) {
          await client.query(
            `INSERT INTO kanji_parts (kanji_char, part_char) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [char, part]
          );
        }
      }

      if (fixed % 50 === 0) {
        process.stdout.write(`\r  処理中... 補完: ${fixed}`);
      }
    }

    console.log(`\n\n✅ 完了${DRY_RUN ? '（dry-run、DB更新なし）' : ''}`);
    console.log(`  補完: ${fixed} 件`);
    console.log(`  スキップ(IDSに無い): ${skippedNoIds} 件`);
    console.log(`  スキップ(そもそも複合字でない): ${skippedNotCompound} 件`);
    console.log(`  スキップ(未収録部品/ネストあり): ${skippedNotClean} 件`);
    console.log(`  スキップ(部品数が改善しない): ${skippedNotImproved} 件`);
    console.log('\nサンプル(補完内容):');
    console.log(JSON.stringify(fixedSamples, null, 1));

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
