---
title: miku-scm の次作業ブランチで期待する HEAD を一貫させる
category: plan
status: complete
created: 2026-11-23
---

# マージ後のブランチ切り替えで再現した2件の対応計画

実装担当は Luna。正本 `miku-scm-skills` の現在の作業ツリーを起点とする。対象はマージ後の `sync pull` と旧入口 `repository.post-merge.next-work`。利用者は今のコマンドと操作 ID で作業を続けられる。ローカル救出の `recover done` は別の処理である。

## 1. 次ブランチの期待値を固定する

[sync-pull.mjs](../../skills/igapyon-miku-scm/scripts/sync-pull.mjs) の `integrateNextWork` は、新しいブランチを確認して `op.integrated_head = op.base_sha` を保存する。初回実行では直後に共通処理が現在の HEAD を読み、保存済みの期待値を上書きする。次ブランチ作成後に別の操作でコミットが増えると、この上書きによって完了判定を通ってしまう。

`next-work` の初回実行でも、再開時と同様に `integrateNextWork` が保存した SHA を `complete` に渡す。共通末尾での HEAD の読み直しと保存は、その場で統合結果を記録する必要がある経路に限る。完了判定は既存の `verifyLocation` が担う。

**受け入れ条件**

- 一時リポジトリで、次ブランチの期待値を保存した後、完了判定までの間に、そのブランチに空コミットを1つ追加する。固定ランナーは `unresolved` を返し、操作記録は同じ ID の `partial`、`integrated_head` は元の `base_sha` になる。追加したコミットも残る。
- 引き継ぐ作業がない状態で、操作記録に `integrated_head` が保存された後の最初の位置確認に割り込む。修正前は HEAD の読み直し、修正後は完了時の位置照合でコミットを追加する。追加した SHA が現在の HEAD にあり、応答の操作 ID が保存した操作 ID と一致することも確認する。通常の切り替え、作業の引き継ぎ、再開は既存テストで確認する。

## 2. 旧入口で準備済みの push を変更する前に、ブランチと SHA を一緒に照合する

旧入口の `legacyPostMergeSnapshot` が使う [snapshot](../../skills/igapyon-miku-scm/scripts/miku-scm-sync-state.mjs) はブランチ名と HEAD を個別に読む。その間に同じ SHA の別の `-done` に切り替わると、準備済みの push を `superseded` にした後で取り違えに気づく。

旧入口のロック取得後、`checkPending` の直前に、入口で確認済みのブランチ名と公開 SHA を [verifyLocation](../../skills/igapyon-miku-scm/scripts/miku-scm-sync-worktree.mjs) の既存の Git 照会で照合する。作業内容を確認するスナップショットと、ステージ済み変更を拒否する既存の検査は引き続き使う。診断には従来どおりブランチの取り違えや公開 SHA の不一致が分かる情報を残す。共有スナップショットの形式やロックの範囲を広げる必要はない。

**受け入れ条件**

- [既存の旧入口テスト](../../skills/igapyon-miku-scm/tests/post-merge-next-work.test.mjs) の準備済み push と同一 SHA の2本の `-done` を使う。旧入口のスナップショットでブランチ名を読んだ直後、HEAD を返す前に別の `-done` に切り替える。切り替えが実際に起きたことを確認する。
- 固定ランナーは `not-applied`、`mutation_invoked: false` を返す。準備済み push の `state.json` は実行前とバイト単位で一致し、fetch と次ブランチ作成に進まない。既存の正しいブランチからの成功例も通る。この照合が保証するのは、確認した時点でのブランチと SHA の一致である。

## 検証と引き継ぎ

各ケースを一時リポジトリとローカルの bare remote で修正前に失敗させ、同じテストが修正後に成功することを確認する。本番コードへのテスト用フックの追加は不要。既存テストの Git 呼び出し差し替えを使う。[開発手順](../../DEVELOPMENT.md) に従い、正本のルートで以下を実行する。

~~~sh
node --test skills/igapyon-miku-scm/tests/post-merge-next-work.test.mjs
npm run contracts:miku-scm
npm run contracts:miku-scm:check
npm run test:miku-scm:fast
npm run test:miku-scm:full
git diff --check
~~~

引き継ぎ時には、1件目は途中停止後の期待 SHA と実際の HEAD、2件目は既存 push 計画の保存内容の一致を報告する。併せて fast と full の成功・失敗件数、契約チェックの結果を記載する。

## 実装結果

次作業ブランチでは `integrateNextWork` が保存した `base_sha` を完了時まで保持し、完了照合に渡すようにした。旧入口では、作業スナップショット後かつ既存操作記録の確認前に、ブランチ名と公開 SHA を既存の `verifyLocation` でまとめて照合する。回帰テストでは次ブランチに追加されたコミットを保持して partial で止まること、同一 SHA の別の `-done` への切替時に準備済み push が変わらないことを確認した。

自己レビュー後、1件目の回帰テストを上記のタイミングに合わせた。期待 SHA の上書きを戻した一時コピーでは誤って `success` になり、同じテストが失敗した。正本では `unresolved` が同じ操作 ID を返し、記録は `partial`、保存した期待 SHA は `base_sha`、実際の HEAD は追加したコミットの SHA と一致した。

検証は回帰テスト2件成功、fast suite 27件成功、full suite 609件成功、失敗0件。契約40件は current で、`git diff --check` も成功した。
