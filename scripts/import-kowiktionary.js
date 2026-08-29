// scripts/import-kowiktionary.js
// 韓国語版ウィクショナリー(ko.wiktionary.org)から、各漢字の韓国語での意味(훈/訓)を取得し、
// kanji.meanings.ko にマージする。
//
// データ出典: 韓国語版ウィクショナリー (CC BY-SA 3.0)
//   https://ko.wiktionary.org/
// 各漢字ページにある {{한자풀이|훈=...|음=...}} テンプレートの「훈」(訓＝意味の要約)を使う。
//
// 実行方法: node scripts/import-kowiktionary.js

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const https = require('https');
const { Pool } = require('pg');

const API_BASE = 'https://ko.wiktionary.org/w/api.php';
const USER_AGENT = 'kanji-dict/1.0 (contact: parkcm2262@gmail.com; one-time batch import)';
const BATCH_SIZE = 50; // MediaWiki API の titles 一括指定の上限
const DELAY_MS = 300;  // リクエスト間隔（Wikimedia APIへの配慮）

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function apiGet(params) {
  const url = `${API_BASE}?${new URLSearchParams(params).toString()}`;
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse failed: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

// ─── wikitext から {{한자풀이|...|훈=...}} の 훈(意味) をすべて抽出する ───────────
function extractHunList(wikitext) {
  const results = [];
  const templateRe = /\{\{한자풀이([\s\S]*?)\}\}/g;
  let tm;
  while ((tm = templateRe.exec(wikitext))) {
    const body = tm[1];
    const hunMatch = body.match(/\|\s*훈\s*=\s*([^|\n]+)/);
    if (!hunMatch) continue;
    let hun = hunMatch[1]
      .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1') // [[X]] / [[X|Y]] -> X
      .replace(/'''?/g, '')
      .trim();
    if (hun) results.push(hun);
  }
  return [...new Set(results)];
}

async function fetchBatch(chars) {
  const data = await apiGet({
    action: 'query',
    titles: chars.join('|'),
    prop: 'revisions',
    rvprop: 'content',
    format: 'json',
    formatversion: '2',
  });
  const out = new Map(); // char -> hunList
  for (const page of data.query?.pages || []) {
    if (page.missing || !page.revisions?.length) continue;
    const hunList = extractHunList(page.revisions[0].content);
    if (hunList.length) out.set(page.title, hunList);
  }
  return out;
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`
      SELECT character FROM kanji
      WHERE meanings IS NULL OR NOT (meanings ? 'ko')
      ORDER BY character
    `);
    console.log(`対象: ${rows.length} 件`);

    let updated = 0;
    let checked = 0;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE).map(r => r.character);
      let hunMap;
      try {
        hunMap = await fetchBatch(chunk);
      } catch (e) {
        console.error(`\nバッチ取得失敗 (${i}): ${e.message}`);
        await sleep(DELAY_MS * 3);
        continue;
      }

      for (const [char, hunList] of hunMap) {
        await client.query(`
          UPDATE kanji
          SET meanings = COALESCE(meanings, '{}'::jsonb) || $1::jsonb
          WHERE character = $2
        `, [JSON.stringify({ ko: hunList }), char]);
        updated++;
      }

      checked += chunk.length;
      process.stdout.write(`\r  進捗: ${checked}/${rows.length} (取得: ${updated})`);
      await sleep(DELAY_MS);
    }

    console.log(`\n\n✅ 完了! 韓国語の意味を取得: ${updated} 件`);

    const { rows: stats } = await client.query(`
      SELECT COUNT(*) FILTER (WHERE meanings ? 'ko') AS has_ko FROM kanji
    `);
    console.log(`DB全体で韓国語意味あり: ${stats[0].has_ko} 件`);

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
