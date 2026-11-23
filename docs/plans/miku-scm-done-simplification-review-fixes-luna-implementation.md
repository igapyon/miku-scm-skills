---
title: miku-scm の凍結ブランチ改善に対する自己レビュー修正計画
description: "マージ後の結果報告と再開案内を修正し、旧版の記録を探す際に循環リンクを読み飛ばす。"
category: plan
status: complete
created: 2026-11-22
updated: 2026-11-22
---

# miku-scm の凍結ブランチ改善に対する自己レビュー修正計画

[前回の実装計画](miku-scm-done-simplification-luna-implementation.md)に沿った変更の自己レビューで、3件を一時 Git リポジトリで再現した。次の順に修正する。マージ後の切り替えには既存の `sync pull` を使い、現在の操作記録と再開オプションで完結させる。

正本は `miku-scm-skills` の `skills/igapyon-miku-scm/`。以下の `scripts/`、`tests/`、`references/` はそこからの相対パス。実装前に [DEVELOPMENT.md](../../DEVELOPMENT.md)、適用される `AGENTS.md`、`git status -sb`、ステージ済みと未ステージの差分を確認する。前回の修正も含め、現在の作業ツリーを起点にする。前回の全体テストは597件成功。

## 1. 旧入口の成功結果を、共通処理が確認した状態から組み立てる

[scripts/post-merge-next-work.mjs](../../skills/igapyon-miku-scm/scripts/post-merge-next-work.mjs) は、共通処理が `completed` を保存した後で `git rev-list HEAD...refs/remotes/…` を呼ぶ。参照が消えると、切り替えと復元が終わっていても固定ランナーは未適用と報告する。

旧入口は完了結果の `previous_branch`、`final_branch`、`head`、`base_commit` を使う。比較の `0 0` は共通処理が返した HEAD とベースの SHA が一致するときに返す。比較不能時の表示は `unknown` とする。リモート追跡参照への再照会を削除する。

作業ツリーの `clean` / `dirty` と、途中停止時の正確な stash の保持確認は補足情報として扱う。Git の補足照会が失敗した場合は、確認できなかった値を `unknown`（`stash_retained` は `null`）とする。共通処理が返した成否、変更実行の有無、操作 ID、元のエラーを報告に使う。

**受け入れ条件**

- [tests/post-merge-next-work.test.mjs](../../skills/igapyon-miku-scm/tests/post-merge-next-work.test.mjs) で、次ブランチの checkout 時にローカルのリモート追跡参照を削除する。固定ランナーは成功と `created` を返し、比較は `0 0`。元の `-done` の参照、次ブランチの HEAD、復元したファイル、元の stash、`completed` の操作記録を確認する。
- 補足の `status` または `stash list` だけを失敗させても、動作の成否と操作 ID が補足照会のエラーに置き換わらない。通常の出力で両方の値が分かる場合は、既存どおり表示する。

## 2. 復元の衝突を解消したら、案内どおりに同じ操作を再開できるようにする

旧入口は停止時に `sync pull --resume <ID>` を案内するが、stash の適用が止まった場合の `--resolved-carryover` が抜けている。[scripts/sync-pull.mjs](../../skills/igapyon-miku-scm/scripts/sync-pull.mjs) の再開条件に合わせ、旧入口の `restore_status` が `failed` の場合は、保存された stash の対象を確認し、衝突を解消してステージした後に `miku-scm sync pull --resume <ID> --resolved-carryover` と案内する。checkout やフックの未確認時の `--resolved-next-work` は引き続き使う。再開先の状態確認と明示確認は、既存の `sync pull` が担当する。

**受け入れ条件**

- 既存の復元衝突テストを延ばし、人向け出力に同じ操作 ID と `--resolved-carryover` が表示されることを確認する。衝突解消をステージ後、案内の引数で `repository.sync.pull` を実行すると、同じ操作 ID のまま完了する。
- 解消内容と元の stash が残り、再開中の stash 再適用や新しいブランチ作成は発生しない。既存の checkout フック失敗から `--resolved-next-work` で再開するテストも通す。

## 3. 旧版の記録探索で循環リンクを読み飛ばす

[scripts/miku-scm-worktree-evidence.mjs](../../skills/igapyon-miku-scm/scripts/miku-scm-worktree-evidence.mjs) の既存の `UNAVAILABLE` に `ELOOP` を加える。別の作業ツリーや候補パスの解決で循環リンクに出会った場合は、その候補を使わず探索を続ける。Git による作業ツリーと参照の照会失敗は従来どおりエラー扱いとする。

**受け入れ条件**

- [tests/done-recovery.test.mjs](../../skills/igapyon-miku-scm/tests/done-recovery.test.mjs) の別作業ツリーフィクスチャで、`workplace` が自分自身を指すリンクを用意する。旧版のバックアップ参照があっても通常ブランチの `sync pull` は成功し、有効な v1 記録があるブランチは引き続き救出ブランチとして止まる。既存の外部向きリンクのケースも通す。

## 完了確認

[マージ後の参照文書](../../skills/igapyon-miku-scm/references/runtime-post-merge.md)に結果の参照元と再開手順を反映する。旧版の記録探索は[救出の参照文書](../../skills/igapyon-miku-scm/references/done-recovery.md)の説明と揃える。実行コード、参照文書、契約テストの変更に対応する生成契約を更新する。

~~~sh
node skills/igapyon-miku-scm/scripts/miku-scm-workflow-contracts.mjs
node skills/igapyon-miku-scm/scripts/miku-scm-workflow-contracts.mjs --check
npm run test:miku-scm:fast
npm run test:miku-scm:full
git diff --check
~~~

各項目の受け入れ条件、両テストスイートの成功・失敗件数、確認した環境を報告する。検証には一時リポジトリとローカルの bare remote を使う。
