// server/test/multiset.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { isExactMultisetMatch } = require('../lib/multiset');

test('同じ要素・同じ個数なら一致', () => {
  assert.equal(isExactMultisetMatch(['口', '口'], ['口', '口']), true);
});

test('個数が違えば不一致（以前のSetベース実装のバグの再現ケース）', () => {
  // remaining=[口,口] のとき、口を1個しか持たない候補は不一致でなければならない
  assert.equal(isExactMultisetMatch(['口', '口'], ['口']), false);
});

test('要素数が違えば不一致', () => {
  assert.equal(isExactMultisetMatch(['亻', '山'], ['亻', '山', '土']), false);
});

test('異体字ではない別の部品なら不一致', () => {
  assert.equal(isExactMultisetMatch(['亻', '山'], ['亻', '土']), false);
});

test('順序が違っても要素・個数が同じなら一致', () => {
  assert.equal(isExactMultisetMatch(['山', '亻'], ['亻', '山']), true);
});
