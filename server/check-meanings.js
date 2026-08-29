require('dotenv').config({ path: '../.env' });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.query(`
  SELECT
    COUNT(*) FILTER (WHERE meanings->>'ja' NOT IN ('[]', 'null') AND meanings IS NOT NULL) AS success,
    COUNT(*) FILTER (WHERE meanings->>'ja' = '[]') AS empty,
    COUNT(*) FILTER (WHERE meanings IS NULL) AS not_tried,
    COUNT(*) FILTER (WHERE meanings->>'ja' = 'null') AS no_page
  FROM kanji WHERE is_joyo = true
`).then(r => {
  console.log('成功（意味あり）:', r.rows[0].success);
  console.log('空（意味なし）  :', r.rows[0].empty);
  console.log('未処理          :', r.rows[0].not_tried);
  console.log('ページなし      :', r.rows[0].no_page);
  pool.end();
});
