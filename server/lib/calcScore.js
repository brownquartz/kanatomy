// server/lib/calcScore.js
// DBに依存しない純粋関数として切り出したスコアリングロジック（テストしやすくするため）。
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

module.exports = { calcScore };
