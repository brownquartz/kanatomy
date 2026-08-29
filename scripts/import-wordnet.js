// scripts/import-wordnet.js
// 日本語WordNetから漢字の意味を取得してDBに投入するスクリプト
//
// 実行手順:
//   1. http://compling.hss.ntu.edu.sg/wnja/data/wnjpn.db.gz をダウンロード
//   2. gunzip して wnjpn.db を scripts/ フォルダに置く
//   3. node scripts/import-wordnet.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const DB_PATH = path.join(__dirname, 'wnjpn.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`❌ WordNetのDBファイルが見つかりません: ${DB_PATH}`);
  console.error('');
  console.error('以下の手順でDBを用意してください:');
  console.error('  1. http://compling.hss.ntu.edu.sg/wnja/data/wnjpn.db.gz をダウンロード');
  console.error('  2. gunzip wnjpn.db.gz');
  console.error('  3. wnjpn.db を scripts/ フォルダに移動');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── WordNetから1文字の漢字の定義を取得 ──────────────────────────────────────
function getMeaningsFromWordNet(wn, char) {
  // 1文字の漢字と一致するlemmaを持つwordを検索（日本語）
  const words = wn.prepare(`
    SELECT wordid FROM word
    WHERE lemma = ? AND lang = 'jpn'
  `).all(char);

  if (!words.length) return [];

  const wordIds = words.map(w => w.wordid);
  const placeholders = wordIds.map(() => '?').join(',');

  // そのwordが属するsynsetを取得
  const synsets = wn.prepare(`
    SELECT DISTINCT s.synset FROM sense s
    WHERE s.wordid IN (${placeholders}) AND s.lang = 'jpn'
  `).all(...wordIds);

  if (!synsets.length) return [];

  const synsetIds = synsets.map(s => s.synset);
  const synsetPlaceholders = synsetIds.map(() => '?').join(',');

  // synsetの日本語定義を取得
  const defs = wn.prepare(`
    SELECT def FROM synset_def
    WHERE synset IN (${synsetPlaceholders}) AND lang = 'jpn'
  `).all(...synsetIds);

  // 重複除去して返す
  return [...new Set(defs.map(d => d.def).filter(Boolean))];
}

// ─── メイン ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('WordNet DB を開いています...');
  const wn = new Database(DB_PATH, { readonly: true });

  // WordNet DBのテーブル確認
  const tables = wn.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('WordNet テーブル:', tables.map(t => t.name).join(', '));

  const client = await pool.connect();

  try {
    // 意味がまだ入っていない漢字（meanings IS NULL または ja キーがない）を取得
    const { rows } = await client.query(`
      SELECT character FROM kanji
      WHERE meanings IS NULL
         OR NOT (meanings ? 'ja')
      ORDER BY character
    `);

    console.log(`対象: ${rows.length} 件`);

    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i++) {
      const char = rows[i].character;
      const meanings = getMeaningsFromWordNet(wn, char);

      if (meanings.length === 0) {
        skipped++;
        continue;
      }

      // 既存のmeaningsにjaキーをマージ（enは上書きしない）
      await client.query(`
        UPDATE kanji
        SET meanings = COALESCE(meanings, '{}'::jsonb) || $1::jsonb
        WHERE character = $2
      `, [JSON.stringify({ ja: meanings }), char]);

      updated++;

      if ((i + 1) % 500 === 0 || i === rows.length - 1) {
        process.stdout.write(`\r  進捗: ${i + 1}/${rows.length} (更新: ${updated}, スキップ: ${skipped})`);
      }
    }

    console.log(`\n\n✅ 完了! 更新: ${updated} 件, スキップ（WordNetになし）: ${skipped} 件`);

    // 結果確認
    const { rows: stats } = await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE meanings ? 'ja') AS has_ja,
        COUNT(*) FILTER (WHERE meanings ? 'en') AS has_en,
        COUNT(*) FILTER (WHERE meanings IS NULL) AS no_meanings
      FROM kanji
    `);
    console.log('\nDB状況:');
    console.log(`  日本語意味あり: ${stats[0].has_ja} 件`);
    console.log(`  英語意味あり:   ${stats[0].has_en} 件`);
    console.log(`  意味なし:       ${stats[0].no_meanings} 件`);

  } finally {
    client.release();
    await pool.end();
    wn.close();
  }
}

main().catch(err => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});
