---
title: miku-scm のマージ後切り替えに対する自己レビュー追加修正計画
description: "確認した凍結ブランチに処理を固定し、保存した完了結果と停止後の再開案内を揃える。"
category: plan
status: complete
created: 2026-11-22
updated: 2026-11-22
---

# miku-scm のマージ後切り替えに対する自己レビュー追加修正計画

[前回の修正](miku-scm-done-simplification-review-fixes-luna-implementation.md)の自己レビューで、旧入口の対象ブランチ、完了報告、ブランチ作成途中からの再開案内に問題を再現した。既存の `sync pull`、操作 ID、保存済み操作記録、再開オプションで対応する。

正本は `miku-scm-skills` の `skills/igapyon-miku-scm/`。以下の `scripts/`、`tests/`、`references/` はそこからの相対パス。[DEVELOPMENT.md](../../DEVELOPMENT.md) と適用される `AGENTS.md` を読み、着手時のブランチ・HEAD・ステージ済み差分・作業ツリー差分を確認する。計画時点の HEAD は `496f91a`。前回までの未コミット修正を含む作業ツリーを起点とする。直近の全体テストは598件成功。

## 1. 旧入口から確認済みのブランチ名と HEAD を一緒に渡す

[scripts/post-merge-next-work.mjs](../../skills/igapyon-miku-scm/scripts/post-merge-next-work.mjs) が確認した `-done` ブランチ名を、公開 HEAD とともに既存の内部引数 `legacyPostMerge` で渡す。[scripts/sync-pull.mjs](../../skills/igapyon-miku-scm/scripts/sync-pull.mjs) はロック取得後の初期スナップショットで両方を照合する。違っていれば fetch や作業の移動より前に停止し、確認時と現在のブランチを示す。旧入口の成功表示には共通結果の `previous_branch`、`final_branch`、`base` を使う。

**受け入れ条件**

同じ HEAD を持つ別の `-done` ブランチを一時リポジトリに作り、旧入口の確認後、共通処理を始める前にそちらへ切り替える。固定ランナーは `not-applied` を返し、両ブランチの名前を報告する。fetch、次ブランチやバックアップの作成、stash の作成を行わず、現在のブランチと手元の変更を保つ。通常の旧入口では、確認した元ブランチが結果と保存記録に一致する。

## 2. 保存直前に確認したブランチと HEAD で完了結果を作る

`sync-pull.mjs` の `complete()` は、ブランチ名と HEAD の照合で取得した値を同じ処理のベース記録と戻り値に使う。`completed` の保存後は、確認済みの値から結果を作る。確認自体が失敗する場合は、完了を記録する前に既存の失敗経路へ進む。旧入口の作業ツリーと stash の補足情報は、読み取れなければ前回の修正どおり不明として表示する。

**受け入れ条件**

実 Git を使い、操作記録の `completed` 保存後に限り HEAD・ブランチの読み直しを失敗させる。旧入口を固定ランナーで呼び、結果が `success` / `created` で、保存記録も `completed` であることを確認する。元の `-done` 参照、次ブランチの HEAD、復元ファイル、元の stash を照合する。通常の `sync pull` の終了結果、確認待ち、キャンセルも既存テストで確認する。

## 3. 共通処理が再開に必要な確認を案内する

次ブランチの作成後、追跡設定の書き込み前に Git が失敗すると、保存状態は `creating` のままブランチ参照が残る。この場合を `sync pull` の再開判定に合わせ、停止結果の既存の `next_action` に同じ操作 ID と `--resolved-next-work` を含める。旧入口はその案内を表示する。

ブランチ参照が残ったことを確認できたら、参照先の SHA と追跡設定を確認し、問題を解消してから再開するよう案内する。参照が作られていなければ通常の `--resume` を案内する。参照を確認できなければ、その旨と確認手順を示す。既存の checkout・フック未確認時の `--resolved-next-work` と、復元後の確認に必要な `--resolved-carryover` も、同じ共通処理で案内する。

**受け入れ条件**

テスト用リポジトリの `.git/config.lock` で追跡設定の書き込みを一時的に止める。次ブランチ参照だけが作成され、停止結果が `--resolved-next-work` を含むことを確認する。ロック解消後に SHA と追跡設定を確認し、必要な設定を補ったうえで案内の引数を渡す。同じ操作 ID とブランチで完了し、元の stash から変更が一度だけ復元される。参照作成前の失敗、checkout フックの失敗、復元衝突からの再開も確認する。

## 4. 固定ランナーの回帰テストを受け入れ条件に合わせる

[tests/post-merge-next-work.test.mjs](../../skills/igapyon-miku-scm/tests/post-merge-next-work.test.mjs) のリモート追跡参照が消えるテストを、補助関数の直接呼び出しから固定ランナーの `repository.post-merge.next-work` に移す。成功表示に加え、操作記録とブランチ・HEAD・stash・作業ファイルを照合する。重複名になったテストのうち、公開後に追加コミットが見つかる方は、処理前に停止することが分かる題名へ戻す。

## 完了確認

[マージ後の参照文書](../../skills/igapyon-miku-scm/references/runtime-post-merge.md)に、作成済みブランチを確認して再開する手順を反映する。対象の回帰テストを確認した後、生成契約と全体テストを確認する。

~~~sh
node skills/igapyon-miku-scm/scripts/miku-scm-workflow-contracts.mjs
node skills/igapyon-miku-scm/scripts/miku-scm-workflow-contracts.mjs --check
npm run test:miku-scm:fast
npm run test:miku-scm:full
git diff --check
~~~

各項目の受け入れ結果とテストの成功・失敗件数を記録する。検証には一時 Git リポジトリとローカルの bare remote を使う。

## 実施記録

4項目を完了した。旧入口が確認した `-done` ブランチ名と SHA をロック後のスナップショットで再照合し、競合時は fetch / stash / branch 作成前に停止する。完了処理は保存直前に確認したブランチと HEAD をベース記録および返却結果に使う。次ブランチ参照が途中作成された状態では SHA と upstream の確認手順、および必要な `--resolved-next-work` を共通 `sync pull` の `next_action` から案内する。再開時に同じ stash から作業を一度だけ戻すことを確認した。旧入口の回帰を固定ランナー経由にし、公開後に追加コミットがあるテスト名を修正した。

受け入れ確認は次のとおり。

- 同じ HEAD を持つ別 `-done` ブランチへの切替注入で `not-applied`。元・現在の branch 名を報告し、Git の fetch / stash / checkout / ref 変更と手元の未追跡ファイルを保持した。
- completed 保存後の branch / HEAD 再読込を失敗させる注入で固定ランナーは `success` / `created`。操作記録は `completed`、元 branch ref、次 branch HEAD、復元ファイル、保持 stash が期待どおりだった。作業ツリーと stash の補足読取失敗は `unknown` として返った。
- `.git/config.lock` により次 branch の tracking 設定を止め、ref が SHA 固定で残るケースと、ref 作成前に失敗するケースの両方を固定ランナーで検証した。前者は `--resolved-next-work` 付き、後者はフラグなしで同じ操作 ID から完了し、stash の変更を一度だけ復元した。checkout hook 失敗と復元衝突からの既存再開回帰も通った。
- 固定ランナーの post-merge 対象テストは26/26成功。workflow contract 40件を再生成後 `--check` で current。

最終検証: `npm run test:miku-scm:fast` は7 jobs / 27 cases成功、`npm run test:miku-scm:full` は62 jobs / 601 cases成功、失敗0。`git diff --check` 成功。ローカルmacOS上の一時Git repositoryとbare remoteで検証し、Windows CIはこの作業では未確認。commit / push は行っていない。
