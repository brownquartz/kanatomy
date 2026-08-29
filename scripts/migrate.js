// scripts/migrate.js
// Railway PostgreSQL へ漢字データを一括投入するマイグレーションスクリプト
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ─── バッチINSERT用ヘルパー ───────────────────────────────────────────────────
async function batchInsert(client, table, columns, rows, chunkSize = 1000) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const placeholders = chunk.map((row, ri) => {
      const ph = row.map((_, ci) => `$${ri * columns.length + ci + 1}`).join(', ');
      values.push(...row);
      return `(${ph})`;
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`,
      values
    );
    process.stdout.write(`\r  ${table}: ${Math.min(i + chunkSize, rows.length)} / ${rows.length}`);
  }
  console.log();
}

// ─── 1. テーブル削除 → 再作成 ────────────────────────────────────────────────
async function createTables(client) {
  console.log('🗑️  既存テーブルを削除中...');
  await client.query(`
    DROP TABLE IF EXISTS kanji_old_new CASCADE;
    DROP TABLE IF EXISTS kanji_variants CASCADE;
    DROP TABLE IF EXISTS kanji_patterns CASCADE;
    DROP TABLE IF EXISTS kanji_parts CASCADE;
    DROP TABLE IF EXISTS kanji CASCADE;
  `);
  console.log('  ✓ 削除完了');

  console.log('📦 テーブル作成中...');
  await client.query(`
    CREATE TABLE kanji (
      character     TEXT PRIMARY KEY,
      unicode_point INTEGER,
      is_joyo       BOOLEAN DEFAULT false,
      is_japanese   BOOLEAN DEFAULT false,
      on_yomi       TEXT[],
      kun_yomi      TEXT[],
      example_yomi  TEXT[],
      stroke_count  INTEGER,
      jlpt_level    INTEGER,
      grade         INTEGER,
      frequency     INTEGER,
      radical       TEXT,
      meanings      JSONB DEFAULT '{}'::jsonb
    );

    CREATE TABLE kanji_parts (
      kanji_char  TEXT NOT NULL,
      part_char   TEXT NOT NULL,
      PRIMARY KEY (kanji_char, part_char)
    );
    CREATE INDEX idx_kanji_parts_part ON kanji_parts(part_char);

    CREATE TABLE kanji_patterns (
      kanji_char  TEXT NOT NULL,
      layer_index INTEGER NOT NULL,
      parts       TEXT[],
      PRIMARY KEY (kanji_char, layer_index)
    );

    CREATE TABLE kanji_variants (
      base_char    TEXT NOT NULL,
      variant_char TEXT NOT NULL,
      PRIMARY KEY (base_char, variant_char)
    );
    CREATE INDEX idx_variants_variant ON kanji_variants(variant_char);

    CREATE TABLE kanji_old_new (
      old_char TEXT PRIMARY KEY,
      new_char TEXT NOT NULL
    );
  `);
  console.log('  ✓ テーブル作成完了');
}

// ─── 2. 全漢字を kanji テーブルに登録 → joyo/japanese で上書き ────────────────
async function importKanji(client) {
  // 2-a) flat_decomp.json から全ユニーク漢字を収集
  console.log('\n📥 全漢字を kanji テーブルに登録中...');
  const flatDecomp = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'flat_decomp.json'), 'utf8'));
  const allChars = new Set();
  for (const [part, kanjiList] of Object.entries(flatDecomp)) {
    allChars.add(part);
    for (const k of kanjiList) allChars.add(k);
  }
  const allRows = [...allChars].map(ch => [ch, ch.codePointAt(0)]);
  await batchInsert(client, 'kanji', ['character', 'unicode_point'], allRows);
  console.log(`  ✓ ${allRows.length} 件登録`);

  // 2-b) old_to_new_kanjis.json → is_japanese = true
  console.log('\n📥 表外漢字フラグ (is_japanese) を設定中...');
  const oldNew = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'old_to_new_kanjis.json'), 'utf8'));
  const japaneseChars = Object.keys(oldNew);
  for (let i = 0; i < japaneseChars.length; i += 1000) {
    const chunk = japaneseChars.slice(i, i + 1000);
    await client.query(
      `UPDATE kanji SET is_japanese = true WHERE character = ANY($1)`,
      [chunk]
    );
  }
  console.log(`  ✓ ${japaneseChars.length} 件更新`);

  // 2-c) joyo2010.json → is_joyo = true + 読み情報を上書き
  console.log('\n📥 常用漢字フラグ + 読みを上書き中...');
  const joyo = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'joyo2010.json'), 'utf8'));
  for (const [unicodeStr, entry] of Object.entries(joyo)) {
    await client.query(
      `INSERT INTO kanji (character, unicode_point, is_joyo, on_yomi, kun_yomi, example_yomi)
       VALUES ($1, $2, true, $3, $4, $5)
       ON CONFLICT (character) DO UPDATE SET
         unicode_point = EXCLUDED.unicode_point,
         is_joyo       = true,
         on_yomi       = EXCLUDED.on_yomi,
         kun_yomi      = EXCLUDED.kun_yomi,
         example_yomi  = EXCLUDED.example_yomi`,
      [
        entry.joyo_kanji,
        parseInt(unicodeStr, 10),
        entry.yomi?.on_yomi || [],
        entry.yomi?.kun_yomi || [],
        entry.yomi?.example_yomi || [],
      ]
    );
  }
  console.log(`  ✓ ${Object.keys(joyo).length} 件更新`);
}

// ─── 3. flat_decomp.json → kanji_parts テーブル ──────────────────────────────
// flat_decomp は { 部品: [漢字1, 漢字2, ...] } の形式
// → (kanji_char, part_char) に変換
async function importKanjiParts(client) {
  console.log('\n📥 flat_decomp.json → kanji_parts テーブル...');
  const data = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'flat_decomp.json'), 'utf8'));
  const rows = [];
  for (const [part, kanjiList] of Object.entries(data)) {
    for (const kanji of kanjiList) {
      rows.push([kanji, part]);
    }
  }
  await batchInsert(client, 'kanji_parts', ['kanji_char', 'part_char'], rows);
  console.log(`  ✓ ${rows.length} 件投入`);
}

// ─── 4. pattern_chunks → kanji_patterns テーブル ─────────────────────────────
async function importKanjiPatterns(client) {
  console.log('\n📥 pattern_chunks → kanji_patterns テーブル...');
  const chunksDir = path.join(PUBLIC_DIR, 'pattern_chunks');
  const files = fs.readdirSync(chunksDir).filter(f => f.endsWith('.json')).sort();
  let total = 0;
  for (const file of files) {
    process.stdout.write(`  チャンク: ${file} `);
    const data = JSON.parse(fs.readFileSync(path.join(chunksDir, file), 'utf8'));
    const rows = [];
    for (const [kanji, layers] of Object.entries(data)) {
      layers.forEach((parts, layerIndex) => {
        rows.push([kanji, layerIndex, parts]);
      });
    }
    await batchInsert(client, 'kanji_patterns', ['kanji_char', 'layer_index', 'parts'], rows);
    total += rows.length;
  }
  console.log(`  ✓ 計 ${total} 件投入`);
}

// ─── 5. variants.json → kanji_variants テーブル ──────────────────────────────
async function importVariants(client) {
  console.log('\n📥 variants.json → kanji_variants テーブル...');
  const data = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'variants.json'), 'utf8'));
  const byBase = data.byBase || {};
  const rows = [];
  for (const [base, variantList] of Object.entries(byBase)) {
    for (const v of variantList) {
      rows.push([base, v]);
    }
  }
  await batchInsert(client, 'kanji_variants', ['base_char', 'variant_char'], rows);
  console.log(`  ✓ ${rows.length} 件投入`);
}

// ─── 6. old_to_new_kanjis.json → kanji_old_new テーブル ──────────────────────
async function importOldNew(client) {
  console.log('\n📥 old_to_new_kanjis.json → kanji_old_new テーブル...');
  const data = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'old_to_new_kanjis.json'), 'utf8'));
  const rows = Object.entries(data);
  await batchInsert(client, 'kanji_old_new', ['old_char', 'new_char'], rows);
  console.log(`  ✓ ${rows.length} 件投入`);
}

// ─── メイン ───────────────────────────────────────────────────────────────────
(async () => {
  const client = await pool.connect();
  try {
    console.log('🚀 Railway PostgreSQL へのマイグレーション開始\n');
    await createTables(client);
    await importKanji(client);       // 全漢字 → is_joyo/is_japanese フラグ付き
    await importKanjiParts(client);  // 部品→漢字 逆引きインデックス
    await importKanjiPatterns(client); // 漢字→部品 分解パターン
    await importVariants(client);    // 異体字
    await importOldNew(client);      // 旧字体→新字体
    console.log('\n✅ マイグレーション完了！');
  } catch (err) {
    console.error('\n❌ エラー:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
})();
