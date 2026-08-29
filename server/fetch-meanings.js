// Wiktionary（日本語版）から常用漢字の意味を取得して DB に保存するスクリプト
// 実行: node fetch-meanings.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Wiktionary API から wikitext を取得 ────────────────────────────────────
const RATE_LIMITED = Symbol('RATE_LIMITED');

async function fetchWikitext(char) {
  const url =
    `https://ja.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(char)}` +
    `&prop=wikitext&format=json&formatversion=2`;
  const res = await fetch(url, { headers: { 'User-Agent': 'KanjiDict/1.0 (educational project)' } });
  if (res.status === 429) return RATE_LIMITED;
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error || !data.parse?.wikitext) return null;
  return data.parse.wikitext;
}

// ── wikitext から意味セクションを抽出 ─────────────────────────────────────
function parseMeanings(wikitext) {
  const meanings = [];

  // ===字義=== または ===意義=== セクションを探す（漢字によって異なる）
  const sectionMatch = wikitext.match(/={2,4}(?:字義|意義)={2,4}\n([\s\S]*?)(?=\n={2,4}[^==])/);
  if (!sectionMatch) return meanings;

  const lines = sectionMatch[1].split('\n');
  for (const line of lines) {
    // トップレベルの番号付き項目のみ（# で始まり ## ではないもの）
    const m = line.match(/^#([^#*:;].+)/);
    if (!m) continue;

    let text = m[1]
      // [[リンク|表示]] → 表示、[[リンク]] → リンク
      .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
      // {{テンプレート}} を除去
      .replace(/\{\{[^}]*\}\}/g, '')
      // '''太字''' や ''斜体'' を除去
      .replace(/'{2,3}/g, '')
      // HTMLタグを除去
      .replace(/<[^>]+>/g, '')
      // 先頭・末尾の空白を除去
      .trim();

    if (text && text.length > 1) meanings.push(text);
  }

  return meanings;
}

// ── メイン処理 ────────────────────────────────────────────────────────────
async function main() {
  // コマンドライン引数: node fetch-meanings.js [limit]
  // 未取得の先頭N件を処理。limit省略で全件。
  const limit = parseInt(process.argv[2] ?? '9999', 10);

  const { rows } = await pool.query(
    `SELECT character FROM kanji
     WHERE is_joyo = true
       AND meanings IS NULL
     ORDER BY character
     LIMIT $1`,
    [limit]
  );
  console.log(`対象: ${rows.length} 字 (limit=${limit})`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const char = rows[i].character;
    try {
      const wikitext = await fetchWikitext(char);

      if (wikitext === RATE_LIMITED) {
        // レート制限 → meanings は NULL のまま（次回リトライ可能）
        console.log(`[レート制限] ${char} - 処理を中断します`);
        break;
      } else if (!wikitext) {
        // ページなし → 「試みたが取れなかった」マークを保存
        await pool.query(
          `UPDATE kanji SET meanings = $1 WHERE character = $2`,
          [JSON.stringify({ ja: null }), char]
        );
        console.log(`[スキップ] ${char} - データなし`);
        failed++;
      } else {
        const ja = parseMeanings(wikitext);
        await pool.query(
          `UPDATE kanji SET meanings = $1 WHERE character = $2`,
          [JSON.stringify({ ja }), char]
        );
        if (ja.length === 0) {
          console.log(`[警告] ${char} - 意味セクションが見つからず`);
          failed++;
        } else {
          success++;
        }
      }
    } catch (e) {
      console.error(`[エラー] ${char}: ${e.message}`);
      failed++;
    }

    // 進捗表示
    if ((i + 1) % 50 === 0) {
      console.log(`進捗: ${i + 1}/${rows.length} (成功: ${success}, 失敗: ${failed})`);
    }

    // Wiktionary に負荷をかけないよう 1秒 待機
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n完了! 成功: ${success}, 失敗: ${failed}`);
  await pool.end();
}

main().catch(console.error);
