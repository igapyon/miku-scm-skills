# miku-scm-skills

[日本語](#日本語)

Simple Git/GitHub synchronization with two requests: `miku-scm sync pull` and `miku-scm sync push`.

Keep your work in sync through Codex: pull shared changes into your work branch, then push your local work to the remote work branch. `igapyon-miku-scm` handles the Git steps behind these two requests, including commits when needed, PR text, backups, and verification. You can also install the independent `igapyon-github-writer` Skill to prepare GitHub text from local evidence.

## Sync with two requests

Use these requests in a cloned repository on an active work branch, with a shared base such as `main` or `devel`.

These are **requests to Codex**, not shell commands:

```text
miku-scm sync pull
miku-scm sync push
```

| Request | Sync direction | What it does |
| --- | --- | --- |
| `miku-scm sync pull` | Shared base → local work branch | Bring in shared changes while preserving local work when the checks allow it. After a PR is merged, prepare the next work branch. |
| `miku-scm sync push` | Local work → remote work branch | Commit changes when needed, prepare PR text, back up and consolidate commits, then push and verify the result. |

Pull to bring in shared changes, make your changes, then push to send your work. The Skill handles the required sequence of Git operations for each request.

### What sync push handles

One `miku-scm sync push` request connects these steps:

1. Commit ordinary non-ignored changes if the worktree is dirty, running the supported repository-declared checks.
2. Draft a PR title and body from the complete base-to-HEAD change range.
3. Create a backup branch and consolidate the work into a commit using that PR text as its message.
4. Push to the work branch after checking the expected remote state, verify the result, and mark the local branch with `-done`.
5. Return the PR creation URL and saved draft for your review.

You create and merge the PR in GitHub. After merging, ask `miku-scm sync pull` again: it checks the merged PR and updated base before creating the next work branch. If PR information is unavailable, it requests confirmation for the exact saved branch and commit.

`sync push` includes **all ordinary non-ignored staged, unstaged, and untracked changes**, including work outside the latest request. Potentially sensitive paths require separate consent. If the shared base has advanced, it stops and asks for `sync pull`; it does not silently pull or increment a version. With nothing to publish, it returns `up-to-date`.

## Why use it?

- **Two requests for everyday sync.** Receive shared changes with `sync pull` and send your work with `sync push`. Fixed Node.js runners handle the Git sequences, checks, and result reporting behind each request.
- **A consistent explanation for review.** PR text covers the changes being consolidated and becomes the final commit message. Saved Markdown drafts can be reviewed and pasted into GitHub.
- **Changes stay tied to what was checked.** Before applying a prepared operation, the runner rechecks the relevant branch, commit, draft, and remote state. An unexpected change stops the operation.
- **Recovery evidence stays available.** Recommit creates a backup; pull retains a stash when it needs to carry local changes. Run records distinguish work that was not applied, partial completion, and an uncertain outcome that needs inspection.

## Choose a Skill

The two Skills are independently installable:

| Skill | Use it for |
| --- | --- |
| [`igapyon-miku-scm`](skills/igapyon-miku-scm/SKILL.md) | Simple synchronization with `sync pull` and `sync push`, plus individual commit/recommit steps, approved Issue operations, local branch maintenance, and version/tag/Release audits. Includes PR, Release, and About drafting. |
| [`igapyon-github-writer`](skills/igapyon-github-writer/SKILL.md) | PR, Release, and About Markdown from local Git history and documents, with draft saving, branch-status reports, and approved local backup/recommit workflows. It never invokes `gh` or accesses the network. |

Both Skills require explicit invocation. Installing both does not make a writing request authorize a push. `miku-scm draft recommit push` belongs to `igapyon-miku-scm`.

## More requests to try

| Request to Codex | Result |
| --- | --- |
| `miku-scm git add commit` | Check and commit the current ordinary non-ignored changes locally, without publishing. Useful for checkpoints before the final PR commit. |
| `miku-scm draft recommit push` | Draft PR text when needed, back up, consolidate already committed work, and push. Use this when an ordinary commit is unnecessary. |
| `miku-scm: draft a completion comment for Issue #123` | Prepare and display the exact proposed comment. Posting waits for a separate exact `approve` or `miku-scm approve` reply. |
| `miku-scm: check tag and Release status` | Compare the committed version, tag, Release, and expected distribution assets without changing them. |
| `miku-scm: diagnose unused local branches` | Inspect completed and backup branches. Deletion requires a reviewed plan and separate approval. |
| `github-writer: write PR text for the current branch` | Draft and save PR Markdown from committed branch changes using local evidence only. |
| `github-writer: write GitHub About text` | Draft a short repository description from the README and project metadata. |

PR creation and merging, tag changes, and Release publication remain human steps in the normal SCM flow. Here, `draft` means the saved PR title and body, not a GitHub draft PR. The older `miku-scm pr recommit push` spelling remains an alias.

## Install

Download `igapyon-miku-scm-skills-<version>.zip` from [GitHub Releases](https://github.com/igapyon/miku-scm-skills/releases), extract it, and copy either or both directories below into `$CODEX_HOME/skills/` (normally `~/.codex/skills/`):

```text
skills/igapyon-miku-scm/
skills/igapyon-github-writer/
```

To install from a source checkout, manually copy the desired directory from `skills/` into `$CODEX_HOME/skills/`. The checkout is the source of truth; copy in this direction only.

See [INSTALL.md](INSTALL.md) for installation steps. After installation, use the Skill's name in a Codex request, as shown above.

## Requirements

- Node.js 22 or newer is required by the included runners. Git is required by both Skills.
- `miku-scm sync pull` requires Git 2.45 or newer. GitHub CLI availability is workflow-specific; Issue operations require existing `gh` authentication, while ordinary sync uses existing Git authentication.
- `igapyon-github-writer` uses local Git evidence only and prohibits `gh`.
- Installing a released ZIP does not require npm dependencies. Repository tests and bundle generation use Node.js built-ins and system `zip` / `unzip` tools.

The SCM workflows follow [miku-soft branch and version conventions](skills/igapyon-miku-scm/references/scm-rules.md). They resolve the shared base from repository configuration and branch records, or ask when it is unclear.

---

# 日本語

`miku-scm sync pull` と `miku-scm sync push` の2つの依頼で、Git/GitHubの同期を簡単に。

Codexへの依頼で、共有された変更を作業ブランチへ取り込み、ローカルの作業をリモートの作業ブランチへ送れます。`igapyon-miku-scm` が、この2つの依頼に必要なGit操作をまとめて実行します。必要に応じたコミット、PR文面作成、バックアップ、結果の確認も同期の流れに含まれます。ローカルの情報からGitHub向けの文章を作る、独立した `igapyon-github-writer` Skillもインストールできます。

## 2つの依頼で同期する

クローン済みのリポジトリで、`main` や `devel` などの共有ベースブランチを持つ作業ブランチに切り替えて使います。

次の例は、シェルコマンドではなく **Codexへの依頼** です。

```text
miku-scm sync pull
miku-scm sync push
```

| 依頼 | 同期の方向 | 実行すること |
| --- | --- | --- |
| `miku-scm sync pull` | 共有ベース → ローカルの作業ブランチ | 確認条件を満たす場合に、ローカルの作業を保ちながら共有された変更を取り込みます。PRのマージ後には、次の作業ブランチを準備します。 |
| `miku-scm sync push` | ローカルの作業 → リモートの作業ブランチ | 必要に応じてコミットし、PR文面を作成して、バックアップとコミットの集約を経てpushし、結果を確認します。 |

pullで共有された変更を取り込み、作業を加えたらpushで送る。それぞれの依頼に必要な一連のGit操作をSkillが担当します。

### sync pushがまとめて行うこと

1回の `miku-scm sync push` の依頼で、次の処理をつなげて実行します。

1. 未コミットの変更があれば、ignore対象を除く通常の変更をコミットします。その際、リポジトリが定義した対応するチェックも実行します。
2. ベースからHEADまでの変更全体をもとに、PRのタイトルと本文を作成します。
3. バックアップブランチを作り、PR文面をコミットメッセージに使って変更を1つのコミットにまとめます。
4. リモートの状態が想定どおりか確認して作業ブランチへpushし、結果を確認して、ローカルのブランチ名に `-done` を付けます。
5. 確認用に、PR作成URLと保存した下書きを返します。

PRの作成とマージは、利用者がGitHub上で行います。マージ後にもう一度 `miku-scm sync pull` と依頼すると、マージ済みのPRと更新されたベースを確認してから、次の作業ブランチを作成します。PR情報を取得できない場合は、保存された対象ブランチとコミットを示して、利用者に確認を求めます。

`sync push` は、最新の依頼以外の作業も含め、**ignore対象を除く通常の変更を、ステージ済み・未ステージ・未追跡のすべてについて対象にします**。機密情報を含む可能性があるパスには、別途同意が必要です。共有ベースブランチが進んでいる場合は停止して `sync pull` を案内し、暗黙のpullやバージョン更新は行いません。pushする変更がなければ `up-to-date` を返します。

## 使うメリット

- **日々の同期を2つの依頼で進められます。** `sync pull` で共有された変更を取り込み、`sync push` で作業を送れます。それぞれに必要なGit操作の手順、チェック、結果の表示は、固定されたNode.jsスクリプトが担当します。
- **レビュー向けの説明とコミットメッセージがそろいます。** PR文面は、まとめる変更の内容を説明し、そのまま最終コミットのメッセージになります。Markdownの下書きを確認してGitHubへ貼り付けられます。
- **確認した内容に結び付けて実行します。** 準備済みの操作を適用する前に、対象のブランチ、コミット、下書き、リモートの状態を再確認します。想定外の変化があれば停止します。
- **復旧の手掛かりが残ります。** 再コミット時はバックアップを作り、pullでローカルの変更を退避する必要があるときはstashを保持します。実行記録では、未適用、一部完了、結果が不確実で確認が必要な状態を区別します。

## Skillの選び方

2つのSkillは、それぞれ独立してインストールできます。

| Skill | 用途 |
| --- | --- |
| [`igapyon-miku-scm`](skills/igapyon-miku-scm/SKILL.md) | `sync pull` と `sync push` による簡単な同期、個別のコミット・再コミット、承認を伴うIssue操作、ローカルブランチの整理、バージョン・タグ・Releaseの監査。PR・Release・Aboutの文面作成も含みます。 |
| [`igapyon-github-writer`](skills/igapyon-github-writer/SKILL.md) | ローカルのGit履歴や文書に基づくPR・Release・AboutのMarkdown作成、下書き保存、ブランチ状況の確認、承認を伴うローカルのバックアップ・再コミット。`gh` の実行やネットワーク接続は行いません。 |

どちらも明示的に呼び出して使います。両方をインストールしていても、文章作成の依頼がpushの許可になることはありません。`miku-scm draft recommit push` は `igapyon-miku-scm` が担当します。

## ほかの依頼例

| Codexへの依頼 | 結果 |
| --- | --- |
| `miku-scm git add commit` | ignore対象を除く現在の通常の変更をチェックし、ローカルでコミットします。pushは行いません。最終的なPR用コミットにまとめる前の、途中経過の保存に使えます。 |
| `miku-scm draft recommit push` | 必要に応じてPR文面を作成し、バックアップを取って、コミット済みの変更をまとめてpushします。通常のコミットが不要な場合に使います。 |
| `miku-scm で Issue #123 に対応完了のコメント案を作って` | 投稿するコメント案を準備し、全文を表示します。投稿には、別のメッセージで正確に `approve` または `miku-scm approve` と返答する必要があります。 |
| `miku-scm でタグとReleaseの状況を確認して` | コミット済みのバージョン、タグ、Release、想定される配布物を、変更せずに照合します。 |
| `miku-scm で不要なローカルブランチを診断して` | 完了済みブランチとバックアップブランチを調べます。削除には、計画の確認と別途の承認が必要です。 |
| `github-writer で今のブランチのPR文面を作って` | ローカルの情報だけを使い、ブランチのコミット済みの変更からPR用Markdownを作成・保存します。 |
| `github-writer で GitHub About を書いて` | READMEとプロジェクトのメタデータから、短いリポジトリ説明文を作成します。 |

通常のSCMフローでは、PRの作成とマージ、タグの変更、Releaseの公開は人間が行います。ここでの `draft` は保存されたPRのタイトルと本文を指し、GitHubのドラフトPRを意味しません。従来の `miku-scm pr recommit push` という表記も別名として使えます。

## インストール

[GitHub Releases](https://github.com/igapyon/miku-scm-skills/releases) から `igapyon-miku-scm-skills-<version>.zip` をダウンロードして展開し、以下のどちらか、または両方のディレクトリを `$CODEX_HOME/skills/`（通常は `~/.codex/skills/`）へコピーします。

```text
skills/igapyon-miku-scm/
skills/igapyon-github-writer/
```

ソースをチェックアウトしている場合は、`skills/` から希望するSkillのディレクトリを `$CODEX_HOME/skills/` へ手動でコピーします。チェックアウトしたリポジトリを正本として、コピーはこの方向にのみ行います。

詳しい手順は [INSTALL.md](INSTALL.md) を参照してください。インストール後は、上の例のようにSkill名を含めてCodexへ依頼します。

## 動作要件

- 同梱の実行スクリプトにはNode.js 22以降が必要です。どちらのSkillにもGitが必要です。
- `miku-scm sync pull` にはGit 2.45以降が必要です。GitHub CLIの必要性はワークフローによって異なります。Issue操作には設定済みの `gh` 認証を使い、通常の同期には設定済みのGit認証を使います。
- `igapyon-github-writer` はローカルのGit情報だけを使い、`gh` は実行しません。
- リリースされたZIPからのインストールにnpm依存パッケージは不要です。リポジトリのテストと配布物の生成には、Node.js標準機能とシステムの `zip` / `unzip` を使います。

SCMワークフローは、[miku-softのブランチ・バージョン規約](skills/igapyon-miku-scm/references/scm-rules.md) に従います。共有ベースブランチはリポジトリ設定とブランチの記録から解決し、不明な場合は利用者に確認します。
