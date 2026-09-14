/**
 * レビュー中の収録案（open かつラベル faq-proposal の Issue）の一覧を
 * data/faq-proposals.json に集計する。
 *
 * サイト（sorcerers-den）の「コミュニティFAQの手引き」とカード頁が、このファイルを
 * raw.githubusercontent.com 経由で読む（CDNキャッシュ約5分）。サイト側の再デプロイは不要。
 * 取れなければサイトは何も出さない（数えていないものを 0 と言わないため）。
 *
 * 出力仕様（サイト側との契約）:
 *   { generated: ISO8601, items: [{ n, url, slug, created, due }] }
 *   - n: Issue 番号 ／ url: Issue の URL
 *   - slug: 「カード名」欄から引ける札（`Name (slug)` の slug が data/slugs.json に実在すれば それ、
 *     無ければ欄を ` / ` 等で切った各片を英語名として照合し、ちょうど1枚に当たればその slug）。
 *     決められなければ null — 当て推量で別の札にしない
 *   - created: 起票日（JSTのYYYY-MM-DD） ／ due: 目処（起票 +7日・JST。**締切ではない**）
 *   - created の新しい順・最大100件
 *   - **題名・本文・投稿者名は入れない** — モデレーション前のテキストをサイトに載せないため
 *     （qa-activity.json と同じ考え。カード名はサイト側が slug から自分のデータで引く）
 *
 * GitHub Actions（.github/workflows/faq-proposals.yml）から issues のイベントと
 * 毎日のcronで実行される。
 * ローカル実行: GITHUB_TOKEN=$(gh auth token) node scripts/faq-proposals.mjs [出力先]
 *   （出力先を渡すと data/faq-proposals.json ではなくそちらへ書く — 手元で試すとき用）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

import { parseIssueForm, targetDate } from "./faq-proposal.mjs";

const PROPOSAL_LABEL = "faq-proposal";
const MAX_ITEMS = 100; // サイトの一覧はこれで十分。JSONの肥大化も防ぐ
const DEFAULT_REPO = "delverdaze/sorcerers-knowledge";
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/* ───────────────────────── 純粋関数（scripts/faq-proposals.test.mjs で検証） ───────────────────────── */

/** 日時を JST の YYYY-MM-DD に。読めなければ空文字（日付を捏造しない）。
    UTC の足し算だけで作るので実行環境のタイムゾーンに依らない（JSTに夏時間は無い） */
export function jstDay(when) {
  const t = Date.parse(when ?? "");
  return Number.isNaN(t) ? "" : new Date(t + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 目処の日付（起票 +7日・JST）。案内コメントと同じ計算（faq-proposal.mjs の targetDate）を使う。
    読めない日時は空文字にして、その件を一覧から落とす（下の buildFeed） */
export function dueDay(when) {
  try {
    return targetDate(when);
  } catch {
    return "";
  }
}

/** 札の名前を照合用にならす。sorcerers-den の js/app.js・admin/issue-import.js の
    normalizeName と同じ規則（NFKD で分音記号を落とし・小文字・英数字以外を捨てる）。
    日本語だけの名前は空になる ＝ 照合の相手にならない（和名からは引かない） */
export function normalizeName(name) {
  return String(name ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** ならした英語名 → その名前を持つ slug の配列（同名が2枚あれば「複数に当たる」と分かる形で持つ）。
    slugs.json は 1100 枚ぶんあるので、同じ台帳で何度も引けるよう覚えておく */
const nameIndexes = new WeakMap();
function nameIndex(slugs) {
  const cached = nameIndexes.get(slugs);
  if (cached) return cached;
  const index = new Map();
  for (const [slug, name] of Object.entries(slugs)) {
    const key = normalizeName(name);
    if (!key) continue;
    index.set(key, [...(index.get(key) ?? []), slug]);
  }
  nameIndexes.set(slugs, index);
  return index;
}

/**
 * 「カード名」欄から slug を取り出す。次の順に見て、決められなければ null
 * （サイト側は null なら札の名前を出さない。当て推量で別の札にしない）:
 *   1. `Name (slug)` の括弧の中が data/slugs.json に実在すれば、それ
 *      （括弧は半角・全角のどちらでも拾うが、実在で判定するので取り違えは起きない）
 *   2. 欄を ` / `・`／`・`/` で切った各片を英語名として台帳の値と照合し、
 *      ちょうど1枚に当たればその slug（「Wuthering Heights / 嵐が丘」のような書き方のため）
 *   3. それ以外（当たらない・複数に当たる・和名だけ）は null
 */
export function slugOfCard(card, slugs) {
  const text = String(card ?? "");
  if (!slugs || typeof slugs !== "object") return null;

  for (const m of text.matchAll(/[(（]\s*([^()（）\s]+)\s*[)）]/g)) {
    if (Object.hasOwn(slugs, m[1])) return m[1];
  }

  const index = nameIndex(slugs);
  const hits = new Set();
  for (const piece of text.split(/[/／]/)) {
    for (const slug of index.get(normalizeName(piece)) ?? []) hits.add(slug);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * GitHub の Issue 一覧（REST の応答そのまま）を配信データに畳む。
 * pull request は除く（Issues API は PR も返す）。日付が読めない件は落とす。
 */
export function buildFeed(issues, slugs, { generated = new Date().toISOString(), repo = DEFAULT_REPO } = {}) {
  const items = [];
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!issue || issue.pull_request) continue;
    const n = Number(issue.number);
    const created = jstDay(issue.created_at);
    const due = dueDay(issue.created_at);
    if (!Number.isInteger(n) || n < 1 || !created || !due) continue;
    const url = typeof issue.html_url === "string" && issue.html_url.startsWith("https://")
      ? issue.html_url
      : `https://github.com/${repo}/issues/${n}`;
    items.push({ n, url, slug: slugOfCard(parseIssueForm(issue.body).card, slugs), created, due });
  }
  // 新しい順。同じ日の起票は番号の大きい方（後から出た方）を先に
  items.sort((a, b) => (a.created === b.created ? b.n - a.n : b.created.localeCompare(a.created)));
  return { generated, items: items.slice(0, MAX_ITEMS) };
}

/** 中身（generated 以外）が同じか。cron のたびに generated だけ変わるコミットを積まないため */
export function sameFeed(prev, next) {
  return JSON.stringify(prev?.items ?? null) === JSON.stringify(next?.items ?? null);
}

/* ───────────────────────── ここから下は GitHub とのやりとり ───────────────────────── */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

async function fetchProposals(token, repo) {
  // per_page=100 は REST の上限。レビュー中の収録案がこれを超えることは想定しない
  // （超えたぶんは GitHub の既定の並び＝新しい順で落ちる）
  const url = `https://api.github.com/repos/${repo}/issues?labels=${PROPOSAL_LABEL}&state=open&per_page=100`;
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "sorcerers-den-faq-proposals",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub API失敗: GET ${url} → ${res.status} ${await res.text()}`);
  const issues = await res.json();
  if (!Array.isArray(issues)) throw new Error(`GitHub API の応答が一覧ではありません: ${JSON.stringify(issues).slice(0, 200)}`);
  return issues;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("GITHUB_TOKEN が必要です（ローカルは GITHUB_TOKEN=$(gh auth token) node scripts/faq-proposals.mjs）");
    process.exit(1);
  }
  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const outPath = process.argv[2] || join(ROOT, "data", "faq-proposals.json");
  const slugs = JSON.parse(readFileSync(join(ROOT, "data", "slugs.json"), "utf8"));

  const issues = await fetchProposals(token, repo);
  const next = buildFeed(issues, slugs, { repo });
  const dropped = issues.filter((i) => i && !i.pull_request).length - next.items.length;
  if (dropped > 0) console.log(`${dropped}件は一覧に入れなかった（日付が読めない・上限100件超）`);

  // 実質的な変化がなければ書き換えない（ワークフロー側は git diff で変更有無を見る）
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(outPath, "utf8"));
  } catch {
    // 初回（ファイルなし・壊れたJSON）はそのまま書き出す
  }
  if (prev && sameFeed(prev, next)) {
    console.log(`変更なし（${next.items.length}件）`);
    return;
  }

  writeFileSync(outPath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`${relative(ROOT, outPath) || outPath} を更新（${next.items.length}件）`);
}

const isEntry = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntry) {
  try {
    await main();
  } catch (err) {
    console.error(`レビュー中の収録案の集計に失敗: ${err.message}`);
    process.exit(1);
  }
}
