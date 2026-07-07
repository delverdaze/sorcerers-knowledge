/**
 * 翻訳データの検証（PR・push時にCIで実行 / ローカルでは `node scripts/validate.mjs`）
 *
 * - すべての JSON がパースできること
 * - data/ja/*.json: slug が slugs.json に実在し、正しいファイル（頭文字）にあること。
 *   各エントリは name（必須・非空文字列）と rules / typeText / flavor（任意・文字列）のみを持つ
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

const CARD_FIELDS = new Set(["name", "rules", "typeText", "flavor"]);
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
        errors.push(`${path}: "${slug}" に未知のフィールド "${key}"（使えるのは name/rules/typeText/flavor）`);
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
