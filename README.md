# Sorcerer's Knowledge

**[Sorcerer's Den](https://github.com/delverdaze)**（*Sorcery: Contested Realm* の非公式日本語リファレンスサイト）のコミュニティリポジトリです。ここには2つのものが集まります。

1. **翻訳データ** — サイトに表示されるカード日本語訳・FAQ和訳（このリポジトリの `data/`）
2. **Q&A掲示板** — カードごとのルール質問・議論（[Discussions](../../discussions)。サイトのカードページに埋め込まれています）

翻訳はプレイヤーみんなでメンテナンスしていくことを目指しています。誤訳の指摘も、より良い訳の提案も歓迎です。

## 貢献のしかた

### かんたん: Issueで報告する

JSONを触らなくてOK。[誤訳・訳の改善報告フォーム](../../issues/new?template=translation-report.yml) にカード名と提案を書くだけです。サイトの各カードページにある「誤訳の報告・改善提案」リンクからも開けます。

### できる人向け: PRを送る

1. 直したいカードのファイルを開く — カード翻訳は `data/ja/<slugの頭文字>.json`（例: Merlin → [data/ja/m.json](data/ja/m.json)）、FAQ和訳は [data/faq-ja.json](data/faq-ja.json)
2. GitHub上で鉛筆アイコン（Edit）から直接編集 → 「Propose changes」でPRになります（フォークは自動）
3. CIがJSONの構文とカードslugの実在を自動チェックします

slug（カードID）が分からないときは [data/slugs.json](data/slugs.json)（slug → 英語カード名の索引）を検索してください。

#### データ形式

```jsonc
// data/ja/m.json — slugをキーに、その頭文字のファイルへ
{
  "merlin": {
    "name": "マーリン",              // 必須: 日本語カード名
    "rules": "魔法の呪文を…",        // 任意: ルール文の訳
    "typeText": "アーサー王伝説の…", // 任意: タイプ行の訳
    "flavor": "…"                    // 任意: フレーバーテキストの訳
  }
}
```

```jsonc
// data/faq-ja.json — "出典|英語の質問原文" をキーに（原文は faq.json 再生成とのズレ防止用なので変更しない）
{
  "faq": {
    "merlin": {
      "official|Can Merlin ...?": { "q": "マーリンは…できますか？", "a": "はい。…" }
    }
  }
}
```

### 翻訳の方針

- **裁定は常に英語原文が優先** — 訳は理解の助けであって、原文の代わりにはなりません
- ゲーム用語（Genesis, Deathrite, スレッショルド等）はサイト内の既訳と揃える — 迷ったら既存の類似カードの訳を検索
- 機械翻訳そのままの投稿はご遠慮ください（下訳に使うのは問題ありません）

## サイトへの反映

このリポジトリの `main` にマージされた翻訳は、**サイトの次回データ更新時**にまとめて反映されます（自動では反映されません）。

## ライセンス・免責

- カード原文・カード画像・ゲーム内容の権利は **Erik's Curiosa Limited** に帰属します。本リポジトリは非公式のファンプロジェクトであり、権利者からの要請があれば速やかに対応します
- このリポジトリの日本語訳データは [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ja)（表示・非営利・継承）で提供します。翻訳の投稿をもって、この条件での提供に同意いただいたものとします
- `scripts/` のコードはMITライセンスです
