# -*- coding: utf-8 -*-
# scripts/compute-visual-similarity.py
# 各漢字を画像としてレンダリングし、phash+dhash(各256bit, 計512bit)を計算して
# kanji.visual_hash に保存する。一回限りのバッチ処理（Node側は生成済みの値を使うだけ）。
#
# 類似度スコアを求めるときの実際の計算はDB側で行う想定:
#   SELECT character, bit_count(visual_hash # $1) AS distance FROM kanji ...
#
# 実行方法: py scripts/compute-visual-similarity.py
# 事前準備: pip install Pillow imagehash psycopg2-binary

import os
import sys

from PIL import Image, ImageDraw, ImageFont
import imagehash
import psycopg2

# .env から DATABASE_URL を読む（dotenvパッケージに頼らず素朴にパースする）
def load_database_url():
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    with open(env_path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("DATABASE_URL="):
                return line.strip().split("=", 1)[1]
    raise RuntimeError("DATABASE_URL not found in .env")

FONT_PATH = r"C:\Windows\Fonts\YuGothR.ttc"
SIZE = 128
HASH_SIZE = 16
BATCH_SIZE = 500

font = ImageFont.truetype(FONT_PATH, SIZE - 20)


def render(ch):
    img = Image.new("L", (SIZE, SIZE), color=255)
    draw = ImageDraw.Draw(img)
    bbox = draw.textbbox((0, 0), ch, font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if w <= 0 or h <= 0:
        return None
    x = (SIZE - w) / 2 - bbox[0]
    y = (SIZE - h) / 2 - bbox[1]
    draw.text((x, y), ch, font=font, fill=0)
    return img


def compute_hash_bits(ch):
    img = render(ch)
    if img is None:
        return None
    p = imagehash.phash(img, hash_size=HASH_SIZE)
    d = imagehash.dhash(img, hash_size=HASH_SIZE)
    # ImageHash.hash は bool の2次元配列。フラットにして '0'/'1' の文字列(bit(512)用)にする
    p_bits = "".join("1" if b else "0" for b in p.hash.flatten())
    d_bits = "".join("1" if b else "0" for b in d.hash.flatten())
    return p_bits + d_bits  # 512 chars


def main():
    conn = psycopg2.connect(load_database_url())
    conn.autocommit = False
    cur = conn.cursor()

    cur.execute("""
        SELECT character FROM kanji
        WHERE (on_yomi IS NOT NULL OR kun_yomi IS NOT NULL)
          AND visual_hash IS NULL
        ORDER BY character
    """)
    rows = cur.fetchall()
    total = len(rows)
    print(f"対象: {total} 件")

    computed = 0
    skipped = 0
    for i, (char,) in enumerate(rows):
        bits = compute_hash_bits(char)
        if bits is None:
            skipped += 1
        else:
            cur.execute(
                "UPDATE kanji SET visual_hash = %s::bit(512) WHERE character = %s",
                (bits, char),
            )
            computed += 1

        if (i + 1) % BATCH_SIZE == 0:
            conn.commit()
            sys.stdout.write(f"\r進捗: {i + 1}/{total} (計算: {computed}, スキップ: {skipped})")
            sys.stdout.flush()

    conn.commit()
    print(f"\n\n完了! 計算: {computed} 件, スキップ(フォントに無い): {skipped} 件")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
