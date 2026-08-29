// scripts/import-kanjidic2.js
// One-time migration: downloads KanjiDic2 XML, parses it, and updates the kanji table.
//
// Usage: node scripts/import-kanjidic2.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const http = require('http');
const zlib = require('zlib');
const sax = require('sax');
const { Pool } = require('pg');

const KANJIDIC2_URL = 'http://www.edrdg.org/kanjidic/kanjidic2.xml.gz';
const BATCH_SIZE = 100;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Phase 1: Parse XML into memory ─────────────────────────────────────────

function parseKanjidic2() {
  return new Promise((resolve, reject) => {
    console.log(`Downloading ${KANJIDIC2_URL} …`);

    const records = [];
    let current = null;
    let inMisc = false;
    let inMeaning = false;
    let meaningLang = null;
    let inReading = false;
    let readingType = null;
    const stack = [];

    const saxStream = sax.createStream(false, { lowercase: true, trim: true, normalize: true });

    saxStream.on('opentag', (node) => {
      stack.push(node.name);
      switch (node.name) {
        case 'character':
          current = {
            literal: null,
            meanings: [],
            on_yomi: [],
            kun_yomi: [],
            stroke_count: null,
            grade: null,
            jlpt: null,
            freq: null,
          };
          inMisc = false;
          break;
        case 'misc':
          if (current) inMisc = true;
          break;
        case 'meaning':
          if (current) {
            inMeaning = true;
            meaningLang = node.attributes['m_lang'] || null;
          }
          break;
        case 'reading':
          if (current) {
            inReading = true;
            readingType = node.attributes['r_type'] || null;
          }
          break;
      }
    });

    saxStream.on('text', (text) => {
      if (!current) return;
      const tag = stack[stack.length - 1];
      switch (tag) {
        case 'literal':
          current.literal = text;
          break;
        case 'stroke_count':
          if (inMisc && current.stroke_count === null) {
            const v = parseInt(text, 10);
            if (!isNaN(v)) current.stroke_count = v;
          }
          break;
        case 'grade':
          if (inMisc && current.grade === null) {
            const v = parseInt(text, 10);
            if (!isNaN(v)) current.grade = v;
          }
          break;
        case 'jlpt':
          if (inMisc && current.jlpt === null) {
            const v = parseInt(text, 10);
            if (!isNaN(v)) current.jlpt = v;
          }
          break;
        case 'freq':
          if (inMisc && current.freq === null) {
            const v = parseInt(text, 10);
            if (!isNaN(v)) current.freq = v;
          }
          break;
        case 'meaning':
          if (inMeaning && meaningLang === null) current.meanings.push(text);
          break;
        case 'reading':
          if (inReading && readingType === 'ja_on') current.on_yomi.push(text);
          else if (inReading && readingType === 'ja_kun') current.kun_yomi.push(text);
          break;
      }
    });

    saxStream.on('closetag', (name) => {
      stack.pop();
      switch (name) {
        case 'misc':    inMisc = false; break;
        case 'meaning': inMeaning = false; meaningLang = null; break;
        case 'reading': inReading = false; readingType = null; break;
        case 'character':
          if (current?.literal) records.push({ ...current });
          current = null;
          inMisc = false;
          break;
      }
    });

    saxStream.on('error', () => {
      if (saxStream._parser) saxStream._parser.error = null;
      saxStream.resume?.();
    });

    saxStream.on('end', () => resolve(records));

    http.get(KANJIDIC2_URL, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const gunzip = zlib.createGunzip();
      gunzip.on('error', reject);
      res.pipe(gunzip).pipe(saxStream);
    }).on('error', reject);
  });
}

// ─── Phase 2: Write to DB ────────────────────────────────────────────────────

async function writeToDb(records) {
  const client = await pool.connect();
  let updated = 0;
  try {
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      for (const rec of chunk) {
        const result = await client.query(
          `UPDATE kanji
           SET
             meanings     = COALESCE(meanings, '{}'::jsonb) || $1::jsonb,
             stroke_count = COALESCE(stroke_count, $2),
             grade        = COALESCE(grade, $3),
             jlpt_level   = COALESCE(jlpt_level, $4),
             frequency    = COALESCE(frequency, $5),
             on_yomi      = COALESCE(on_yomi, $6),
             kun_yomi     = COALESCE(kun_yomi, $7)
           WHERE character = $8`,
          [
            JSON.stringify({ en: rec.meanings }),
            rec.stroke_count,
            rec.grade,
            rec.jlpt,
            rec.freq,
            rec.on_yomi,
            rec.kun_yomi,
            rec.literal,
          ]
        );
        if (result.rowCount > 0) updated++;
      }
      process.stdout.write(`\r  DB更新中: ${Math.min(i + BATCH_SIZE, records.length)} / ${records.length} (更新: ${updated})`);
    }
    console.log(`\n完了! 更新: ${updated} 件`);
  } finally {
    client.release();
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const records = await parseKanjidic2();
  console.log(`パース完了: ${records.length} 件`);
  await writeToDb(records);
  await pool.end();
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
