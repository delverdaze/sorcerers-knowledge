/**
 * コミュニティFAQの収録案（Issue Form: .github/ISSUE_TEMPLATE/faq-proposal.yml）が
 * 起票されたら、レビューの案内をコメントし、状態のラベルを付ける。
 *
 * **契約はフォームの label** — 起票された本文は欄ごとに `### <label>` の見出しと値で
 * 組まれる（未入力は `_No response_`、checkboxes は `- [x] …` / `- [ ] …`、
 * `type: markdown` の文は本文に残らない）。フォームの label を変えたら
 * FIELD_BY_HEADING も直す。同じ規則の構文解析を sorcerers-den 側（/admin/ の
 * 「Issue から読み込む」）も持つ — リポジトリをまたいだ import はしない。
 *
 * 案内の文面の正本: sorcerers-den リポジトリ
 *   aidlc-docs/operations/community-faq-admin.md「Issue でレビューしてから収録する」
 * 設計と経緯: 同 aidlc-docs/inception/community-faq-review-proposal.md（構造的決定 19）
 *
 * GitHub Actions（.github/workflows/faq-proposal.yml）から issues の
 * opened / labeled イベントで起動される。
 * ローカル確認: GITHUB_EVENT_NAME=issues GITHUB_EVENT_PATH=<イベントJSON> node scripts/faq-proposal.mjs
 * GITHUB_TOKEN 未設定時は GitHub へ一切読み書きせず、出すはずの案内とラベルを
 * 表示して正常終了する（シークレット無しでも確認できるように）。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** フォームの label → 鍵（sorcerers-den 側の取り込みと同じ対応表） */
const FIELD_BY_HEADING = new Map([
  ["カード名", "card"],
  ["質問（英語）", "qEn"],
  ["回答（英語）", "aEn"],
  ["質問（日本語）", "qJa"],
  ["回答（日本語）", "aJa"],
  ["根拠", "basis"],
  ["元となった議論・投稿の日付", "date"],
  ["クレジット表記（任意）", "credit"],
  ["特に見てほしい点", "focus"],
  ["確認", "confirm"],
]);

const NO_RESPONSE = "_No response_"; // Issue Form が未入力の欄に書く値
const PROPOSAL_LABEL = "faq-proposal";
const REVIEW_LABEL = "needs-review";
/** 案内を出した印。本文に埋め、次の起動で二重投稿しないための目印にする */
const NOTICE_MARK = "<!-- faq-proposal-notice -->";
const REVIEW_DAYS = 7; // 目処（締切ではない）
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ラベルの台帳（無ければこの色と説明で作る）。正本は提案書の「ラベル」表 */
const LABELS = {
  [PROPOSAL_LABEL]: { color: "6e8b74", description: "コミュニティFAQの収録案" },
  [REVIEW_LABEL]: { color: "d4a72c", description: "レビュー募集中（7日ほどを目処）" },
  "needs-ja": { color: "bfd4f2", description: "和訳待ち" },
  "needs-en": { color: "bfd4f2", description: "英訳待ち" },
  ready: { color: "0e8a16", description: "目処を過ぎて異論なし・収録待ち" },
};

/* ───────────────────────── 純粋関数（scripts/faq-proposal.test.mjs で検証） ───────────────────────── */

/**
 * `### 見出し` ごとに本文を区切る。コードフェンス（``` / ~~~）の中の `###` は
 * 見出しにしない（起票者がルール文を貼ったときに壊れないように）。
 */
function splitSections(body) {
  const sections = [];
  let current = null;
  let fence = null;
  for (const raw of String(body ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      // 閉じるのは同じ記号・同じ長さ以上で、後ろに情報文字列が無い行だけ
      if (mark && mark[1][0] === fence.char && mark[1].length >= fence.len && !mark[2].trim()) fence = null;
    } else if (mark && !(mark[1][0] === "`" && mark[2].includes("`"))) {
      fence = { char: mark[1][0], len: mark[1].length };
    }
    const heading = fence ? null : /^ {0,3}###\s+(.+)$/.exec(line);
    if (heading) {
      current = { heading: heading[1].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(raw);
    }
    // 最初の見出しより前（フォーム外の追記など）は捨てる
  }
  return sections;
}

/** 節の本文を1つの文字列に。未入力（`_No response_`）は空文字にする */
function sectionText(lines) {
  const text = lines.join("\n").trim();
  return text === NO_RESPONSE ? "" : text;
}

/** checkboxes の節を `{ checked, label }` の配列に */
function parseCheckboxes(lines) {
  const items = [];
  for (const line of lines) {
    const m = /^\s*[-*]\s+\[([ xX])\]\s*(.*)$/.exec(line);
    if (m) items.push({ checked: m[1].toLowerCase() === "x", label: m[2].trim() });
  }
  return items;
}

/**
 * Issue 本文をフォームの欄ごとに分解する。
 * 知らない見出しは捨てずに `extra`（見出し → 値）に残す。同じ見出しが2度あれば後勝ち。
 */
export function parseIssueForm(body) {
  const fields = {
    card: "", qEn: "", aEn: "", qJa: "", aJa: "",
    basis: "", date: "", credit: "", focus: "",
    confirm: [], extra: {},
  };
  for (const { heading, lines } of splitSections(body)) {
    const key = FIELD_BY_HEADING.get(heading);
    if (key === "confirm") fields.confirm = parseCheckboxes(lines);
    else if (key) fields[key] = sectionText(lines);
    else fields.extra[heading] = sectionText(lines);
  }
  return fields;
}

/** 起票（created_at）+ 7日を JST の YYYY-MM-DD で。締切ではなく目処の日付 */
export function targetDate(createdAt) {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) throw new Error(`起票日時が日付として読めません: ${createdAt}`);
  // UTC で足してから JST の壁時計に直す（実行環境のタイムゾーンに依存させない）
  return new Date(t + REVIEW_DAYS * 86400000 + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 片言語の判定 — Q と A が揃っていない側のラベルを返す（英語→日本語の順） */
export function missingLanguages(fields) {
  const filled = (value) => typeof value === "string" && value.trim() !== "";
  const missing = [];
  if (!(filled(fields?.qEn) && filled(fields?.aEn))) missing.push("needs-en");
  if (!(filled(fields?.qJa) && filled(fields?.aJa))) missing.push("needs-ja");
  return missing;
}

/** 片言語のときだけ添える一文（付けたラベルの意味を書いておく） */
function languageNote(missing) {
  if (!missing?.length) return "";
  const NAME = { "needs-en": "英語", "needs-ja": "日本語" };
  const langs = missing.map((name) => NAME[name] ?? name).join("・");
  const labels = missing.map((name) => `\`${name}\``).join(" ");
  return `${langs}の質問・回答が揃っていないようなので ${labels} を付けました。訳を書いていただける方も歓迎です（無ければ管理人が訳します）。\n`;
}

/**
 * 起票直後に貼るレビュー案内。文面の正本は community-faq-admin.md の定型文で、
 * 目処の日付を2箇所に埋める。冒頭に印（NOTICE_MARK）を置いて二重投稿を防ぐ。
 */
export function buildComment({ number, targetDate: due, missing = [] } = {}) {
  return [
    NOTICE_MARK,
    `レビューのお願い（${due} ごろを目処に）`,
    "",
    "この収録案を見ていただける方は、次のどれか一つだけでも構いません。",
    "1. 裁定: 公式FAQ・Judge FAQ・Codex と食い違わないか",
    "2. 文面: 誤解を生まないか、再構成として過不足がないか",
    "3. 和訳: 用語がサイトの既訳（カード頁の訳）と揃っているか",
    "",
    "賛成なら本文に 👍、気になる点があれば 😕 と理由をコメントでお願いします。",
    `${due} ごろを目処に、異論が無ければ管理人がサイトへ収録します。締切ではありません。それ以降のご意見も歓迎で、収録後でも直します（収録後も非公式で、公式裁定・英語原文が優先です）。`,
    "",
    `${languageNote(missing)}収録したときは、カード頁の出典に \`Reviewed in sorcerers-knowledge #${number}\` としてこの Issue へのリンクが残ります。`,
  ].join("\n");
}

/* ───────────────────────── ここから下は GitHub とのやりとり ───────────────────────── */

const token = process.env.GITHUB_TOKEN;
const [owner, repo] = (process.env.GITHUB_REPOSITORY || "delverdaze/sorcerers-knowledge").split("/"); // 空文字でも既定へ

async function request(path, { method = "GET", body } = {}) {
  return fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "sorcerers-den-faq-proposal",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function api(path, options) {
  const res = await request(path, options);
  if (!res.ok) {
    throw new Error(`GitHub API失敗: ${options?.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

/** ラベルが無ければ台帳の色と説明で作る（先に作ってあればそのまま使う） */
async function ensureLabel(name) {
  const res = await request(`/labels/${encodeURIComponent(name)}`);
  if (res.ok) return;
  if (res.status !== 404) throw new Error(`ラベル確認に失敗: ${name} → ${res.status} ${await res.text()}`);
  const def = LABELS[name];
  if (!def) throw new Error(`ラベル ${name} が無く、台帳にも定義がありません`);
  await api("/labels", { method: "POST", body: { name, color: def.color, description: def.description } });
  console.log(`ラベル ${name} を作成した`);
}

function labelNames(issue) {
  return (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH が未設定です（イベントJSONの場所）");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const issue = event.issue;
  if (!issue) {
    console.log("issue を含まないイベントのためスキップ");
    return;
  }

  // ワークフロー側でも絞っているが、手動実行や設定変更に備えてここでも確かめる
  const labels = labelNames(issue);
  if (!labels.includes(PROPOSAL_LABEL) && event.label?.name !== PROPOSAL_LABEL) {
    console.log(`#${issue.number} はラベル ${PROPOSAL_LABEL} が無いため何もしない`);
    return;
  }

  const fields = parseIssueForm(issue.body);
  const due = targetDate(issue.created_at);
  const missing = missingLanguages(fields);
  const comment = buildComment({ number: issue.number, targetDate: due, missing });
  // 片言語のラベル → needs-review の順。既に付いているものは足さない
  const wanted = [...missing, REVIEW_LABEL].filter((name) => !labels.includes(name));

  if (!token) {
    console.log(`GITHUB_TOKEN 未設定 — 送信せず内容のみ表示（#${issue.number}・目処 ${due}）:`);
    console.log("--- コメント ---");
    console.log(comment);
    console.log("--- 付けるラベル ---");
    console.log(wanted.length ? wanted.join(" ") : "（無し）");
    return;
  }

  const existing = await api(`/issues/${issue.number}/comments?per_page=100`);
  if (existing.some((c) => (c.body ?? "").includes(NOTICE_MARK))) {
    console.log(`#${issue.number} には既に案内のコメントがあるため何もしない`);
    return;
  }

  await api(`/issues/${issue.number}/comments`, { method: "POST", body: { body: comment } });
  console.log(`#${issue.number} に案内をコメントした（目処 ${due}）`);

  if (!wanted.length) {
    console.log("付け足すラベルは無い");
    return;
  }
  for (const name of wanted) await ensureLabel(name);
  await api(`/issues/${issue.number}/labels`, { method: "POST", body: { labels: wanted } });
  console.log(`ラベルを付けた: ${wanted.join(" ")}`);
}

const isEntry = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntry) {
  try {
    await main();
  } catch (err) {
    console.error(`収録案の案内に失敗: ${err.message}`);
    process.exit(1);
  }
}
