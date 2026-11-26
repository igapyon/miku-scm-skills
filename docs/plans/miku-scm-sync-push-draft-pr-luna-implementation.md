---
title: miku-scm sync push の Draft PR 自動作成
description: "push の確認後に GitHub CLI で Draft PR を作成し、push と PR の結果を個別に記録する。"
category: plan
status: implemented
created: 2026-11-27
---

# miku-scm sync push の Draft PR 自動作成

実装担当は Luna。通常の `miku-scm sync push` で、公開済みブランチから GitHub 上の Draft PR を作る。push 前に保存した Markdown のタイトルと本文を再利用する。**`gh` が PATH にない場合は PR 作成を省略し、push が確認済みなら成功として完了する。** 利用者には手動作成用の URL と保存済みの文面パスを返す。

[DEVELOPMENT.md](../../DEVELOPMENT.md) と適用される `AGENTS.md` を確認する。正本は `skills/igapyon-miku-scm/`。以下で特記しない `scripts/`、`tests/`、`references/` はこのディレクトリからの相対パス。計画時点の HEAD は `d7ca5a6`。4ファイルの未ステージの `0.9.3` 更新は既存作業として保持し、着手時に最新の差分を確認する。

## 1. 利用者から見た動作

- 通常の `miku-scm sync push` 1回で、必要なコミット、PR 文面の保存、recommit、push とその確認、Draft PR 作成まで進む。従来の `prepare → draft.prepare → apply` を使い、同じ依頼が新規 Draft PR 1件の作成も許可する。
- 新規作成または既存 PR の確認に成功したら、番号、URL、Draft 状態を返す。レビューへの切り替えとマージ、タグや Release の操作は人が行う。マージ後は従来どおり `miku-scm sync pull` を使う。
- Draft PR 作成を追加する入口は `repository.sync.push.apply` と、後述する同じ操作の PR 再開入口。単独の `draft recommit push`、`pr.publish.apply`、GitHub Writer と Issue の承認手順は従来の契約を保つ。push 対象がない `up-to-date` は PR の照会や作成を伴わない。
- GitHub への PR 作成は `pull_request: opened` の契機になり得る。このリポジトリの PR 用 CI は Draft PR の作成時点で開始し得る。CI の設定は本件の対象外とする。[GitHub Actions のイベント仕様](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)

## 2. push の完了を先に保存する

1. [sync-push.mjs](../../skills/igapyon-miku-scm/scripts/sync-push.mjs) の `applySyncPush` から従来の `runRecommitPush` を呼ぶ。追加の PR 処理に進める条件は `delegate.status === "published"`、公開結果の `comparison === "0 0"`、公開 SHA と recommit 後の SHA の一致、想定どおりの公開ブランチとローカル `-done` の確認。push 失敗や不明時の停止・復旧は既存どおり。
2. 同じリポジトリロックの内側で、`op.delegate`、Git 側の `op.status: "completed"` と PR 処理の初期記録を、最初の PR 照会の前に `saveOperation` で一緒に保存する。PR 処理は `op.draft_pr` に持ち、PR 側の結果に応じて更新する。Git 側を閉じる前に保存が失敗した場合は既存の push 復旧手順に従う。
3. [post-recommit-publish.mjs](../../skills/igapyon-miku-scm/scripts/post-recommit-publish.mjs) の `resolvePrHandoff` は単独の公開フロー向けに留める。sync からの委譲時だけ、既存の `recommitPushDependencies.publishDependencies` を通した内部設定で簡易 PR 照会を省略する。新しい照会で手動作成 URL と PR 情報を組み立てる。公開結果、公開 receipt、`0 0`、バックアップ、タグ候補の既存検証を通す。
4. PR 処理には Git 側の apply と区別したエラー処理を置く。認証エラーや PR 試行結果の保存失敗でも、確認済みの Git 結果と `completed` を保つ。これにより、ロック解放後は手動で作成・マージした PR からも `sync pull` で続行できる。PR の試行結果が保存できなかった場合は、最後に保存された試行開始記録から読み取りで復旧する。

### 保存する項目

既存の `workplace/miku-scm/sync/operations/<id>/state.json` に `draft_pr` を追加する。最初の保存に `schema_version: 1`、`status: "ready"`、`target`、`attempt: null` を含める。

- `target` は操作 ID、計画 SHA-256、選択した remote 名と既存の remote 設定 digest、公開先の host と `owner/repo`、公開ブランチ名、`-done` 名、recommit 後の完全 SHA、base 名、確認済みの draft パスと draft SHA-256 を持つ。Git の URL に資格情報が含まれる場合も、記録には正規化したリポジトリ識別子と digest だけを使う。
- `attempt` は `gh pr create` の直前に `pending` と時刻を保存する。保存に成功した場合にだけ子プロセスを起動する。この保存から結果保存までにプロセスが中断したら、作成済みの可能性がある状態として扱う。作成後は分類、確認できた PR 番号・URL・状態、終了コード・spawn エラー分類などの短い診断を残す。タイトル・本文、環境変数、CLI の生出力は複製しない。
- PR 状態は `skipped`、`not-created`、`conflict`、`created`、`existing`、`unresolved` を使う。作成が呼び出された可能性を後から判定できるよう、`attempt: null` または確実な起動前失敗と、`attempt.status: "pending" | "unresolved"` を区別する。観測できた既存 PR は `existing` とし、必要に応じて `state` と `merged` を併記する。

## 3. 固定ヘルパーで PR を照会して作成する

`scripts/miku-scm-sync-draft-pr.mjs` に処理を分ける。既存の `createGhCommandRunner`、`repositoryFromRemote`、`ghRepository`、`repositoryApiArgs` を使い、以下のコマンドを固定の引数配列で実行する。

~~~text
gh api --method GET repos/<owner>/<repo>/pulls --hostname <host>
  -f state=all -f head=<owner>:<published-branch> -f per_page=100
gh api --method GET repos/<owner>/<repo>/pulls/<number> --hostname <host>
gh pr create --draft --repo <host>/<owner>/<repo>
  --head <published-branch> --base <saved-base> --title <title> --body-file <temporary-file>
~~~

`--head` は同一リポジトリ内のブランチ名を指定する。ローカルの `-done` や所有者接頭辞は付けない。host と owner/repo は選択した remote から取得し、`GH_HOST` やカレントブランチに推測させない。shell なし、`GH_PROMPT_DISABLED=1`、各プロセスのタイムアウトは15秒とする。CLI の出力は既存の上限付き runner で受け、診断は分類した内容だけを返す。CLI の明示 `--head` は fork と追加 push を省略する。[GitHub CLI の作成コマンド](https://cli.github.com/manual/gh_pr_create) [GitHub CLI の環境変数](https://cli.github.com/manual/gh_help_environment)

### 事前照会と既存 PR の判定

1. リポジトリの host・owner・repo と Git の ref 名を検証する。同一リポジトリの公開先を特定できない remote は `skipped`（`unsupported-remote`）。認証済み GitHub アクセスには既存の `gh` 設定を使う。別 base の open PR も検出するため、一覧 GET は `head` で絞り込み、base は取得後に照合する。[GitHub Pull Requests API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests)
2. 最初の固定 GET の spawn `ENOENT` は `skipped`（`gh-not-found`）。`gh` の有無を OS 別のシェルで検査する必要はない。認証・権限・通信などで GET が失敗したら `not-created`。配列でない応答、照合に必要な項目が不正な応答、100件に達した応答も、PR がない根拠に使わず `not-created` とする。
3. head/base のリポジトリと ref、head の完全 SHA で照合する。フォークなど、異なる head リポジトリの PR は除外する。同じ対象に一致する PR が一意で、open またはマージ済みなら詳細 GET で再確認して `existing`。open の Draft・通常 PR はどちらも受け入れる。対象と同一の head/base/SHA の閉じた未マージ PR、複数の完全一致、同じ公開ブランチを head にする別 base や別 SHA の open PR は `conflict`。この場合は検証できた関連 URL を返して人に判断を委ねる。過去の別 SHA の閉じた PR は今回の作成を妨げない。
4. 作成候補がない場合に限り、送信前に local の `-done` と HEAD、`assertRemote` による remote 設定、公開された head SHA および base ref の存在を再確認する。リモート参照は固定 `git ls-remote --heads <remote> refs/heads/<published-branch> refs/heads/<base>` で正確な ref 名と SHA を読む。base の参照先は通常の GitHub PR と同様に更新されうるため、保存した base 名に固定する。閉じた PR の重複判定は [sync pull の照合](../../skills/igapyon-miku-scm/scripts/miku-scm-sync-merge-check.mjs) と同じ head/base/SHA を使う。

### 文面と作成後の照合

1. 作成直前に `draftBytes` と SHA-256 を確認し、そのとき読んだ同じバイト列からタイトルと本文を作る。厳密な UTF-8 として読み、改行を LF に揃える。1行目は空でないタイトル、残りは本文とする。タイトル直後の区切りの空行がある場合は1行だけ取り除き、本文のインデント、空行、末尾の改行を保つ。空の本文や NUL を含む入力は作成前に止め、保存済みの原文は保持する。
2. 本文だけを専用の一時ディレクトリに置き、所有者のみが読める設定で `--body-file` に渡す。終了時に除去し、一時ファイルの失敗は起動前の失敗として記録する。書き直しやコミットメッセージからの再生成は不要。CRLF の原文もハッシュは元のバイト列で比較する。
3. 試行開始を保存してから `gh pr create` を1回呼ぶ。正常終了の stdout から取得した URL は host、owner/repo、`/pull/<正整数>` まで検証し、その番号の詳細 GET で URL、番号、両リポジトリ、両 ref、head SHA、`state: open`、`draft: true` を確認して `created` とする。exit 0 や URL 単体での成功判定は避ける。
4. 作成呼び出し自体が spawn `ENOENT` なら起動していないので `skipped`。その他、起動していないことが結果から証明できるエラーは `not-created`。子プロセスが起動した可能性があり、タイムアウト、非ゼロ終了、URL 不正、詳細 GET 失敗、SHA・状態の不一致を観測した場合は `unresolved`。GitHub の作成コマンドは SHA を指定して書き込めないため、head が照合直後に動く競合は作成後の照合で検出する。結果不明時は作成の再送や PR の変更を行わず、以下の読み取り復旧へ進む。

## 4. 同じ操作の PR 段階だけを再開する

利用者の明示依頼 `miku-scm sync push --resume-pr <操作ID>` を次の固定ワークフローへルーティングする。通常は Agent が直前の結果から ID を引き継ぐ。

~~~text
node <skill-root>/scripts/miku-scm-run.mjs --format json
  repository.sync.push.pr.resume --repo <same-repo> --operation <same-id> --apply
~~~

- `--operation` と `--apply` を必須とし、remote、base、SHA、文面の上書き引数は設けない。対象のロックを取ってから exact ID の操作を読み、必要なら既存の dead lock 回収の条件を使う。worktree、common Git directory、計画の digest、保存済みの公開結果、PR 処理の target が一致し、対象の `-done` と HEAD が現在の checkout にある場合だけ続ける。
- `ready`、`gh-not-found`、起動前に停止した `not-created` は、通常の事前照会と再検証をすべて通した場合に限り、PR 作成に進める。PR が手動で作成済みなら既存 PR として返す。文面の digest が変わった場合は送信前に止める。計画の apply 契約が現行と異なる場合も、保存済みの対象を読む用途に限る。
- 試行が `pending` や `unresolved` の場合は、同じ head の一覧・詳細 GET で照合する。対象が一意で open またはマージ済みなら `existing` として返し、誰が作成したかは推定しない。0件や照会不能の場合は `unresolved` を保持する。過去に `created` または `existing` と記録した操作と、`conflict` で停止した操作も再照会だけを許可する。
- 旧版の完了済み操作や PR 初期記録がない操作は、この入口から作成できない。旧版の未適用計画は既存の契約差分処理で再準備する。`up-to-date` や `sync pull` 済みの別ブランチから古い PR の作成に進む経路も設けない。
- 再開で行う Git 操作は対象 ref と設定の照会に限る。新しいコミット、recommit、push、branch rename の回数はすべて0。今回の実行で作成を発行しなければ `pull_request_mutation: false`、今回の作成を確認できれば `true`、今回の作成が結果不明なら `null` を返す。過去の試行が不明で今回が読み取りだけの場合は、`pr_status: "unresolved"` と試行記録でその事実を表す。

## 5. CLI の結果とドキュメントを揃える

Git の成功後は常に `publication_state: "published"` を返し、`pr_status` と理由を別に返す。新規作成・既存確認の際は `pr_number`、`pr_url`、`pr_is_draft` を返す。手動作成の案内には、リポジトリが特定できる場合の `<repo-url>/compare/<encoded-base>...<encoded-head>?expand=1` と `pr_draft` を含める。結果不明時は手動作成 URL より先に同じ ID の照合を案内する。

| PR の結果 | `sync push` の delegate 結果 | 人向けの表示 |
| --- | --- | --- |
| `created` / `existing` | `published`、exit 0 | push 済み、PR 番号・URL・状態 |
| `skipped` | `published`、exit 0 | push 済み、作成省略の理由、手動作成の案内 |
| `not-created` / `conflict` | `partial`、exit 1 | push 済み、PR 段階の停止理由、該当 PR または同じ操作の次の手順 |
| `unresolved` | `unresolved`、exit 1 | push 済み、PR 作成結果は未確認、読み取り復旧を案内 |

`repository.sync.push.pr.resume` 自体が失敗しても、確認済みの Git 結果は別に表示する。再開成功時の delegate 結果は `created` または `existing`、省略は `skipped` とし、exit 0。送信前に停止したものは `not-applied` または `conflict`、結果不明は `unresolved` とし、exit 1。

| 変更先 | 作業 |
| --- | --- |
| `scripts/miku-scm-run.mjs`、`scripts/miku-scm-cli-contracts.mjs` | PR 再開入口、引数、ネットワーク・認証の説明を追加。通常 apply の引数は既存のまま |
| `scripts/miku-scm-workflow-manifest.mjs` | `repository.sync.push.apply` の契約を v4 → v5。PR 再開を v1、`remote`、`apply` で登録。新ヘルパーと使用する共通コードを該当する契約の runtime sources に含め、同じ契約テストから追えるようにする |
| `scripts/miku-scm-human-output.mjs` | push と PR の結果を両方表示。旧フローの「PR を作成」の案内を結果に合わせて切り替え、既存の JSON 項目と、マージ後の `sync pull` 案内を維持する |
| `SKILL.md`、`references/runtime-sync-push.md`、`references/sync-push.md`、`references/workflow-routing.md` | 標準フローの権限、`gh` 不在時の省略、PR だけの再開条件、`-done` で許可される入口と報告を記述 |
| `references/github-cli-static-helper-policy.md` とルート `README.md` | 許可する GET/作成の固定引数、上限、結果照合を追加。README の日英フローでローカル文面と GitHub Draft PR の違いを説明 |

## 6. 受け入れテスト

`tests/sync-push.test.mjs`、`tests/miku-scm-sync-push-output.test.mjs` と既存の同期 fixture を使う。新ヘルパーの入出力は専用テストで確認する。実 Git は一時リポジトリと bare remote、GitHub 呼び出しは注入した fake `gh` を使う。対象 remote の Git URL 書き換えを使う場合も、外部ネットワークに出ないことを確認する。

| ケース | 確認する結果 |
| --- | --- |
| 正常作成 | push の確認と `-done` の保存後にのみ PR 照会と作成が進む。引数配列を完全一致で比較し、作成1回と詳細 GET を確認。本文ファイルには日本語、改行、Markdown、シェルの記号を含む期待値がそのまま入る |
| `gh` が PATH にない | spawn `ENOENT` を使い、作成呼び出し0回、`published`、exit 0、手動 URL、保存済み文面、`-done` を確認 |
| 既存 PR と競合 | 同一対象の Draft・通常 PR、マージ済み、閉じた未マージ、別 base、別 SHA、複数一致、フォーク混在を区別する。曖昧・不完全な一覧から作成しない |
| host/ref の固定 | 選択した Enterprise host と同じ `--repo`・`--hostname`、非既定の base、スラッシュを含む head を使う。別 host の URL、別 ref/SHA、リモート設定変更、消えた head/base は拒否する |
| 作成前の停止と再開 | GET の認証失敗、文面の改変、試行記録の保存失敗で作成0回。再開可能な元の記録から同一の対象を再確認し、成功しても追加 push は0回 |
| 作成後に結果不明 | タイムアウト、非ゼロ終了、URL 不正、GET 失敗を注入。Git の receipt は成功、PR は `unresolved`。再開時に PR が見つかる場合と空のままの場合の両方で作成追加0回 |
| 中断と競合 | `pending` の保存直後、作成応答後かつ結果保存前の中断を再現し、同じ ID の再開が読み取り専用になる。2プロセスの重複呼び出しは既存ロックと保存済み試行で抑える |
| 互換性 | push 不明と `up-to-date` では Draft PR 処理0回。単独公開、旧記録の扱い、明示引数の拒否、help の副作用なしを確認。PR が保留でも手動作成・マージ済みなら既存 `sync pull` が切り替えに成功 |

契約ロックと参照表は生成コマンドで更新する。Luna の実装時に対象テスト、fast、full を順に確認する。

~~~sh
npm run contracts:miku-scm
npm run contracts:miku-scm:check
npm run check:version
node --test skills/igapyon-miku-scm/tests/miku-scm-sync-draft-pr.test.mjs
node --test skills/igapyon-miku-scm/tests/sync-push.test.mjs
node --test skills/igapyon-miku-scm/tests/miku-scm-sync-push-output.test.mjs
npm run test:miku-scm:fast
npm run test:miku-scm:full
git diff --check
~~~

引き継ぎ時には、`gh` 不在時の exit 0、Draft PR 作成の呼び出しが1回である根拠、作成結果不明からの再開結果、契約チェックとテストの成功・失敗件数を記録する。

## 実装記録

- `gh` の spawn `ENOENT` はDraft PR作成を省略し、Git pushの成功状態、手動比較URL、保存済み文面パスを返す。
- 公開処理での従来の簡易PR照会は `sync push` からの呼び出しに限って遅延し、完了済みGit操作を保存した後、専用ヘルパーでPR一覧・詳細照合とDraft PR作成を行う。
- 作成結果が不明な場合は `repository.sync.push.pr.resume` を登録し、同じ操作の読み取り照合だけを再開する。PR作成の再送は行わない。
- 実 Git の一時bare remoteと偽 `gh` で作成、既存PR、`gh` 不在、競合、結果不明からの再開、タイトル・本文のargv／本文ファイル渡しを確認した。実 GitHub へのPR作成は行っていない。
- 確認結果: 契約41件 current、版数0.9.3 aligned、fast 27件成功、full 63ファイル・620件成功、`git diff --check` 成功。
