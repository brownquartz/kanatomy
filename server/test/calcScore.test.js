// server/test/calcScore.test.js
// Node組み込みのテストランナー（追加依存なし）。 `node --test` で実行できる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { calcScore } = require('../lib/calcScore');

test('完全一致（品 = 口口口）は最高スコアになる', () => {
  const score = calcScore(['口', '口', '口'], ['口', '口', '口']);
  assert.equal(score, 110); // recall=1, precision=1, orderBonus=10 => 70+30+10
});

test('部分一致（要求2個中1個しか無い候補）は満点にならない', () => {
  // 以前のバグ: 候補側のサイズだけで判定していたため、こういうケースが
  // 不当に高スコア（実質100%扱い）になっていた。
  const full = calcScore(['水', '也'], ['水', '也']);       // 池のような2部品ぴったりの候補
  const partial = calcScore(['水'], ['水', '也']);          // 水だけの候補（也が要求から漏れている）
  assert.ok(partial < full, `partial(${partial}) should score lower than full(${full})`);
});

test('重複部品を含む検索（口口口）で正しく数を数えられる', () => {
  // 品(口,口,口)相当の候補は満点、口を1つしか持たない候補は低くなるはず
  const triple = calcScore(['口', '口', '口'], ['口', '口', '口']);
  const single = calcScore(['口', '土'], ['口', '口', '口']);
  assert.ok(single < triple);
});

test('要求部品を全く持たない候補はスコア0', () => {
  const score = calcScore(['木', '目'], ['水', '也']);
  assert.equal(score, 0);
});

test('部品の順序が一致しているとボーナスが乗る', () => {
  const inOrder = calcScore(['亻', '山'], ['亻', '山']);
  const outOfOrder = calcScore(['山', '亻'], ['亻', '山']);
  assert.ok(inOrder > outOfOrder);
});

test('空の入力・空のpatternPartsは0を返す（例外を投げない）', () => {
  assert.equal(calcScore([], ['口']), 0);
  assert.equal(calcScore(['口'], []), 0);
});
