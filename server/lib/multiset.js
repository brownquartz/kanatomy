// server/lib/multiset.js
// 部品の「個数まで含めた」完全一致判定。以前は Set ベースで比較していたため、
// 例えば remaining=[口,口] のとき「口が1個しかない漢字」も一致扱いになってしまう
// バグがあった（重複が握りつぶされるため）。個数を数えて比較する。
function countBy(arr) {
  const counts = {};
  for (const item of arr) counts[item] = (counts[item] || 0) + 1;
  return counts;
}

// a・b が同じ要素を同じ個数だけ持つ（＝多重集合として等しい）かどうか
function isExactMultisetMatch(a, b) {
  if (a.length !== b.length) return false;
  const countsA = countBy(a);
  const countsB = countBy(b);
  return Object.entries(countsA).every(([item, n]) => countsB[item] === n);
}

module.exports = { countBy, isExactMultisetMatch };
