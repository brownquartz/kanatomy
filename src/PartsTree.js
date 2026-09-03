// src/PartsTree.js
// 漢字の親子分解ツリー表示。上部に「全部品」の一覧（全体像）、下に折りたたみ式の
// 入れ子ツリー（各要素をクリックすると、その部品自体の分解が見える）を表示する。
import React, { useState } from 'react';

// ツリーを平坦化して、ルート自身を除いた重複無しの文字リストを作る（全体像用）
function flattenParts(node, out = new Set(), isRoot = true) {
  if (!isRoot) out.add(node.character);
  for (const child of node.parts) flattenParts(child, out, false);
  return out;
}

function TreeNode({ node, onPartClick, depth }) {
  const hasChildren = node.parts.length > 0;
  const [expanded, setExpanded] = useState(depth < 1);

  return (
    <li className="parts-tree__node">
      <div className="parts-tree__row">
        {hasChildren ? (
          <button
            type="button"
            className="parts-tree__toggle"
            onClick={() => setExpanded(e => !e)}
            aria-label={expanded ? '折りたたむ' : '展開する'}
          >
            {expanded ? '▼' : '▶'}
          </button>
        ) : (
          <span className="parts-tree__toggle parts-tree__toggle--leaf" />
        )}
        <span
          className="parts-tree__char"
          onClick={() => onPartClick?.(node.character)}
          title={`${node.character} のページを見る`}
        >
          {node.character}
        </span>
        {!hasChildren && <span className="parts-tree__leaf-label">(基本の字)</span>}
      </div>
      {hasChildren && expanded && (
        <ul className="parts-tree__children">
          {node.parts.map((child, i) => (
            <TreeNode key={i} node={child} onPartClick={onPartClick} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export default function PartsTree({ tree, onPartClick }) {
  if (!tree || !tree.parts?.length) return null;
  const allParts = [...flattenParts(tree)];

  return (
    <div className="parts-tree">
      <p>全部品(まとめ):</p>
      <ul className="parts-list">
        {allParts.map((p, i) => (
          <li key={i} onClick={() => onPartClick?.(p)} className="part-item">
            {p}
          </li>
        ))}
      </ul>

      <p style={{ marginTop: '1rem' }}>分解ツリー(クリックで展開/各文字をクリックでそのページへ):</p>
      <ul className="parts-tree__root">
        <TreeNode node={tree} onPartClick={onPartClick} depth={0} />
      </ul>
    </div>
  );
}
