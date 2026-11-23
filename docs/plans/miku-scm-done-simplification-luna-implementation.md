---
title: miku-scm の凍結ブランチ救出と切り替えを簡素化する実装計画
description: "Luna が救出時のファイル読み取り、切り替えの二重実装、旧版の記録に起因する停止を順に解消する。"
category: plan
status: planned
created: 2026-11-22
updated: 2026-11-22
---

# miku-scm の凍結ブランチ救出と切り替えを簡素化する実装計画

Luna は、事故後に手元の作業を持ち出す `miku-scm recover done` と、マージ済みのブランチから次の作業へ進む `miku-scm sync pull` を改善する。下の3件を順に実施し、各項目で一時リポジトリを使って再現と修正を確認する。既存の操作と同期の保存情報で完結させる。

## 着手する場所

正本は別リポジトリの `miku-scm-skills`。本書のあるリポジトリの `skills/igapyon-miku-scm/` が製品ソースで、以下の `scripts/`、`tests/`、`references/` はそこからの相対パス。着手時に [DEVELOPMENT.md](../../DEVELOPMENT.md)、適用される `AGENTS.md`、`git status -sb`、`git diff --stat`、`git diff --cached --stat` を確認する。計画時はブランチ `devel-tiga1113ieb`、HEAD `496f91a` に前段の修正が未コミットで入っていた。実装は作業ツリーの現状を起点とし、既存差分を保持する。直近の全体テストは592件成功。

## 1. 救出時に作業ファイルの内容を読まない

変更の中心は [done-recovery.mjs](../../skills/igapyon-miku-scm/scripts/done-recovery.mjs)。`fingerprintPath` と作業ファイルのハッシュ計算を削る。切り替え直前に現在ブランチと HEAD を再照合し、同じ HEAD への既存の `git switch -c` を使う。進行中の Git 操作と未解決のインデックス競合を確認する。フックの抑止は検査から切り替え後の確認まで適用する。

確認に使うのは元と救出先の参照、現在の HEAD、`git ls-files --stage -z` のステージ情報。生のバイト列で切り替え前後を照合する。救出中の `status` と `diff` による作業ツリー検査は削り、JSON の `working_tree` は `unknown` を返す。失敗時は既存の結果形式で観測できた現在ブランチと HEAD を示す。

[done-recovery.test.mjs](../../skills/igapyon-miku-scm/tests/done-recovery.test.mjs) に、読めない未追跡ファイルがあっても元ブランチと救出先が同じ SHA を指し、ステージ済み・未ステージの変更と未追跡ファイルが保たれる回帰条件を入れる。POSIX では権限を落としたファイルの読み取りが実際に失敗することを確かめる。既存のフック、ブランチ衝突、進行中の Git 操作、大きな未追跡ファイルのテストも通す。

## 2. マージ後の切り替えを一つの処理にする

[sync-pull.mjs](../../skills/igapyon-miku-scm/scripts/sync-pull.mjs) の next-work 経路を使う。名前選び、履歴検査、次ブランチの準備・切り替え、タグの参考情報を提供する既存関数は、必要な範囲で小さな共通モジュールへ移して循環 import を解く。旧 [post-merge-next-work.mjs](../../skills/igapyon-miku-scm/scripts/post-merge-next-work.mjs) の独自の fetch、stash、ブランチ作成・切り替え、復元を削る。

旧 `repository.post-merge.next-work` は既存の ID と引数を受け取る互換入口とする。remote と base の指定・省略時の解決を保つ。元の `-done` ブランチ、`--published-head` の完全 SHA と現在 HEAD の一致、明示の `--confirmed-merged --apply`、ステージ済み変更があれば停止する条件を確認する。明示確認と SHA は内部呼び出しで渡す。共通処理で取得した共有ブランチにその HEAD が含まれるときだけ進む。旧入口ではローカル bare remote でも同じ Git 履歴確認で動く。通常の `sync pull` では正確な PR 照合、squash merge の処理、既存の確認待ちからの再開を維持する。

旧入口の成功出力は `created` と既存のブランチ・base・タグ・stash 情報を返す。比較結果は共通処理で確認した SHA に基づく。途中停止は共通の状態と操作 ID を出し、既存の `sync pull --resume` で扱う。旧入口にも sync pull の安全上の前提が適用されることを、参照文書と案内に反映する。

[post-merge-next-work.test.mjs](../../skills/igapyon-miku-scm/tests/post-merge-next-work.test.mjs) と [sync-pull-next-work.test.mjs](../../skills/igapyon-miku-scm/tests/sync-pull-next-work.test.mjs) で両入口を通す。共有ブランチが追跡するパスを手元に無視ファイルとして置き、さらに引き継ぐ未追跡ファイルを用意する。両入口とも stash 作成・新しい参照の作成前に停止し、ファイルが元に残ることを確認する。共通経路で切り替え後にフックが失敗した場合は、元の stash を保ち、同じ操作 ID で再開できることも確認する。旧入口の通常成功、ステージ済み変更の停止、公開 HEAD の不一致、通常の PR 検証と人の確認経路を回帰対象に含める。

## 3. 旧版の記録を対象ブランチに結び付ける

[miku-scm-rescue-branch.mjs](../../skills/igapyon-miku-scm/scripts/miku-scm-rescue-branch.mjs) は `rescue/done/*` を引き続き局所作業として扱う。旧形式の作業ブランチでは、共有 Git の v1 バックアップ参照と対象ブランチの作成 reflog を先に使う。旧版の統合モードなどで記録が必要なときは、同じ Git リポジトリの確認済み作業ツリーにある、バックアップ ID に対応する JSON だけを読む。既存の schema、ID、バックアップ SHA、対象ブランチの照合を維持する。

[miku-scm-worktree-evidence.mjs](../../skills/igapyon-miku-scm/scripts/miku-scm-worktree-evidence.mjs) では、別作業ツリーの欠落・権限不足・シンボリックリンク先などにより使えない候補を除外する。ローカル Git 自体の照会失敗は通常のエラーとして扱う。判定の根拠を失った旧版ブランチは識別できない場合があるため、既存の説明に残す。

[done-recovery.test.mjs](../../skills/igapyon-miku-scm/tests/done-recovery.test.mjs) で、旧バックアップ参照があるリポジトリの別作業ツリーに `workplace` のシンボリックリンクを置き、通常ブランチの `sync pull` が進むことを確認する。同じ Git のバックアップと対象ブランチに一致する正常な v1 記録では、そのブランチの sync・公開を止める。旧版の統合モードはリモート追跡参照から作ったブランチを使い、記録から識別できることを確かめる。作業ツリー移動・削除後の reflog による判定と、別リポジトリにコピーされた記録の既存テストも維持する。

## 完了確認

実装と同じ差分で `references/done-recovery.md`、`references/runtime-done-recovery.md`、`references/runtime-post-merge.md`、`references/sync-pull.md` と関連する契約を揃える。共通モジュールを移す場合は manifest の実行時依存も合わせる。生成物は契約生成コマンドで更新する。

```sh
node skills/igapyon-miku-scm/scripts/miku-scm-workflow-contracts.mjs
node skills/igapyon-miku-scm/scripts/miku-scm-workflow-contracts.mjs --check
npm run test:miku-scm:fast
npm run test:miku-scm:full
git diff --check
```

Luna は各項目の受け入れ条件の結果と、全体テストの通過・失敗件数、未確認の環境を報告する。公開操作の確認には一時リポジトリのローカル bare remote を使う。対応範囲は製品コード・テスト・参照文書・契約の更新とローカル検証まで。
