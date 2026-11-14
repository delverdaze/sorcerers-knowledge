/**
 * 翻訳データの検証（PR・push時にCIで実行 / ローカルでは `node scripts/validate.mjs`）
 *
 * - すべての JSON がパースできること
 * - data/ja/*.json: slug が slugs.json に実在し、正しいファイル（頭文字）にあること。
 *   各エントリは name（必須・非空文字列）と rules / typeText / flavor（任意・文字列）のみを持つ。
 *   両面カード（Druid）は faces を持てる: { front / back: { rules / typeText / flavor }, printings: { <刷りid>: { typeText } } }
 *   （面ごとの訳。省略した面はカード本体の訳にフォールバックする。刷りの id は Sorcerers' Den の artVariants と同じ）
 *   刷りで英文の違うタイプ行・フレーバーは variants に「英文 → 和訳」で持てる: { typeText: { <英文>: <和訳> }, flavor: { … } }
 *   （鍵は印刷の英文そのもの。Sorcerers' Den が刷りの英文と字形を均して照らし、当たる刷りにだけその訳を出す。
 *    どの刷りにも当たらない鍵は Den の取り込みが止まる。typeText / flavor はカードとしての値＝既定の刷りの英文の訳のまま）
 * - data/faq-ja.json: slug が実在し、キーは "official|質問原文" または "judge|質問原文"、
 *   値は q / a（必須・非空文字列）のみを持つ
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function load(path) {
  try {
    return JSON.parse(readFileSync(join(root, path), "utf8"));
  } catch (err) {
    errors.push(`${path}: JSONとして読めません — ${err.message}`);
    return null;
  }
}

const slugs = load("data/slugs.json");

const CARD_FIELDS = new Set(["name", "rules", "typeText", "flavor", "faces", "variants"]);
const VARIANT_FIELDS = new Set(["typeText", "flavor"]);

/* 刷りごとの別版: variants.typeText / variants.flavor は「英文 → 和訳」。鍵（英文）も値（和訳）も空でない文字列 */
function validateVariants(path, slug, variants) {
  if (typeof variants !== "object" || variants === null || Array.isArray(variants)) {
    errors.push(`${path}: "${slug}" の variants がオブジェクトではありません`);
    return;
  }
  for (const [field, map] of Object.entries(variants)) {
    if (!VARIANT_FIELDS.has(field)) { errors.push(`${path}: "${slug}" の variants に未知のフィールド "${field}"（使えるのは typeText/flavor）`); continue; }
    if (typeof map !== "object" || map === null || Array.isArray(map) || !Object.keys(map).length) {
      errors.push(`${path}: "${slug}" の variants.${field} は「英文 → 和訳」のオブジェクト（1件以上）にしてください`);
      continue;
    }
    for (const [en, ja] of Object.entries(map)) {
      if (!en.trim()) errors.push(`${path}: "${slug}" の variants.${field} に空の英文の鍵があります`);
      if (typeof ja !== "string" || !ja.trim()) errors.push(`${path}: "${slug}" の variants.${field}「${en.slice(0, 40)}…」の和訳が空か文字列ではありません`);
    }
  }
}
const FACE_FIELDS = new Set(["rules", "typeText", "flavor"]);

/* 両面カードの faces: 面（front / back）ごとの訳と、刷りごとのタイプ行の印字。文字列以外・未知の鍵は誤り */
function validateFaces(path, slug, faces) {
  if (typeof faces !== "object" || faces === null || Array.isArray(faces)) {
    errors.push(`${path}: "${slug}" の faces がオブジェクトではありません`);
    return;
  }
  for (const [key, value] of Object.entries(faces)) {
    if (key === "printings") {
      if (typeof value !== "object" || value === null) { errors.push(`${path}: "${slug}" の faces.printings がオブジェクトではありません`); continue; }
      for (const [id, printing] of Object.entries(value)) {
        for (const [k, v] of Object.entries(printing ?? {})) {
          if (k !== "typeText") errors.push(`${path}: "${slug}" の faces.printings.${id} に未知のフィールド "${k}"（使えるのは typeText）`);
          else if (typeof v !== "string") errors.push(`${path}: "${slug}" の faces.printings.${id}.typeText が文字列ではありません`);
        }
      }
      continue;
    }
    if (key !== "front" && key !== "back") { errors.push(`${path}: "${slug}" の faces に未知の面 "${key}"（使えるのは front/back/printings）`); continue; }
    for (const [k, v] of Object.entries(value ?? {})) {
      if (!FACE_FIELDS.has(k)) errors.push(`${path}: "${slug}" の faces.${key} に未知のフィールド "${k}"（使えるのは rules/typeText/flavor）`);
      else if (typeof v !== "string") errors.push(`${path}: "${slug}" の faces.${key}.${k} が文字列ではありません`);
    }
  }
}
for (const file of readdirSync(join(root, "data/ja")).sort()) {
  const path = `data/ja/${file}`;
  const doc = load(path);
  if (!doc || !slugs) continue;
  const bucket = file.replace(".json", "");
  for (const [slug, entry] of Object.entries(doc)) {
    if (!(slug in slugs)) {
      errors.push(`${path}: slug "${slug}" は存在しません（data/slugs.json を確認）`);
      continue;
    }
    const expected = /^[a-z]/.test(slug) ? slug[0] : "0-9";
    if (expected !== bucket) {
      errors.push(`${path}: "${slug}" は ${expected}.json にあるべきです`);
    }
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${path}: "${slug}" の値がオブジェクトではありません`);
      continue;
    }
    if (typeof entry.name !== "string" || !entry.name.trim()) {
      errors.push(`${path}: "${slug}" に name（日本語カード名）がありません`);
    }
    for (const [key, value] of Object.entries(entry)) {
      if (!CARD_FIELDS.has(key)) {
        errors.push(`${path}: "${slug}" に未知のフィールド "${key}"（使えるのは name/rules/typeText/flavor/faces/variants）`);
      } else if (key === "faces") {
        validateFaces(path, slug, value);
      } else if (key === "variants") {
        validateVariants(path, slug, value);
      } else if (typeof value !== "string") {
        errors.push(`${path}: "${slug}" の ${key} が文字列ではありません`);
      }
    }
  }
}

const faqDoc = load("data/faq-ja.json");
if (faqDoc && slugs) {
  for (const [slug, entries] of Object.entries(faqDoc.faq ?? {})) {
    if (!(slug in slugs)) {
      errors.push(`data/faq-ja.json: slug "${slug}" は存在しません`);
      continue;
    }
    for (const [key, qa] of Object.entries(entries)) {
      const src = key.split("|", 1)[0];
      if (!key.includes("|") || !["official", "judge"].includes(src)) {
        errors.push(`data/faq-ja.json: ${slug} のキー "${key.slice(0, 60)}…" は "official|原文" か "judge|原文" の形式が必要`);
      }
      for (const field of ["q", "a"]) {
        if (typeof qa?.[field] !== "string" || !qa[field].trim()) {
          errors.push(`data/faq-ja.json: ${slug} / "${key.slice(0, 60)}…" に ${field} がありません`);
        }
      }
    }
  }
}

if (errors.length) {
  console.error(`✗ 検証エラー ${errors.length} 件:\n`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("✓ すべての翻訳データが検証を通過しました");
