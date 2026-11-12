# miku-scm-skillsへの2 Skill移行計画（Luna向け）

状態: 新側実装中。2026-11-12作成。計画作成後、新側の骨格、2 Skill、CI、配布・検査スクリプトを実装中。ローカル検証を進めている。GitHub公開と元側からの除去はまだ行っていない。実施状況は`docs/migration-execution.md`を参照する。

## 1. 合意する移行の形

利用者の指定順序に従い、次の3段階で進める。

1. 新リポジトリに2 Skillと、それらの保守・配布に必要なファイルをコピーし、単独で検証・配布できる状態にする。
2. 新リポジトリのGitHub Releasesで、2 Skillを含むインストール用ZIPを公開し、再ダウンロードした実物を検証する。
3. 公開確認後、元リポジトリの現在の作業ブランチから2 Skillと、それらを内部製品として扱う設定・記述を除去する。

今回の計画では、元側の配布対象からも2 Skillを外す。外部同梱への付け替えは行わない。元側に残るdaybook等の実際の依存は、新配布先から別途導入する前提へ更新する。

- 新リポジトリ: `igapyon/miku-scm-skills`
- 新ローカル作業先: `/Users/igapyon/Documents/git/miku-scm-skills`
- 元ローカル作業先: `/Users/igapyon/Documents/git/igapyon-agent-skills`
- 正式なSkill名: `igapyon-miku-scm`、`igapyon-github-writer`
- 新側の正本: `skills/igapyon-miku-scm/`、`skills/igapyon-github-writer/`
- 製品形態: 現時点ではSkill-only。将来の独立Node CLIは本移行の範囲に含めない。

Skill名、起動条件、workflow ID、承認・復旧規則を維持する。`miku-scm draft recommit push`は引き続きmiku-scmが所有し、github-writerのネットワーク・`gh`禁止も維持する。

今回は利用者指定の「コピー」による移行とし、Git履歴の抽出・書き換えを追加しない。出自となる元コミットとファイル対応を新側に記録する。元側のGit履歴と既存Releaseは出自の参照先として残る。

## 2. 読み取り調査で確認した現状

| 対象 | 計画作成時の状態 |
| --- | --- |
| 元側branch | `devel-tiga1112wfh`、`origin/devel`を追跡 |
| 元側HEAD | `23a2e492fd957d1ac051943fce341689ec1025a1` |
| 新側branch | `devel-tiga1112xbf`、`origin/devel`を追跡 |
| 新側HEAD | `59ce27871e09c6687c85418000a0949db4315b3c`、`Initial commit` |
| 新側の既存ファイル | `.git/`、`LICENSE`。LICENSEとGitの初期状態を保持する |
| 新側origin | `git@github.com:igapyon/miku-scm-skills.git`。これはローカル設定の確認であり、リモート到達性の検証ではない |
| 製品版数 | miku-scm runnerとgithub-writer manifestの両方が`1.20261112.4` |
| 元側の配布数 | 内部15 Skill + 外部13 Skill = 28 Skill |
| 移行後の元側の予定数 | 内部13 Skill + 外部13 Skill = 26 Skill |
| 元側の代表参照経路 | 現在14 Skill分。2 Skill除去後は12 Skill分 |

両作業ツリーは計画書作成前にcleanだった。実装開始時にはbranch、HEAD、差分を取り直す。ここに書いたbranchや版数を根拠に、古い状態へのreset・checkoutをしない。

`workplace/`内には姉妹Skillリポジトリのcheckoutがなかった。代わりに既存のローカルcheckoutである`../miku-indexgen-skills`と`../miku-text-bundle-skills`を読み取った。`private: true`、`skills/`を正本とする配置、bundle/ZIPコマンド、タグを指定してcheckoutするRelease workflowを形の参考とする。姉妹側のNode 20設定、単一Skill前提、不要なJava/Node runtime同梱方針は転写しない。共有developer skillのAgent Skills starterも単一Skill前提なので、2 Skillへの対応が必要。

## 3. MIG-00: 実装開始時の記録と作業境界

新側に`docs/migration-from-agent-skills.md`と`docs/migration-execution.md`を作る。前者は恒久的な出自・移行先一覧、後者は工程別の実施証跡とする。

実施証跡へ次を記録する。

- 両側のbranch、完全なHEAD SHA、開始時の差分、Node/Git/npmの版数。
- コピー対象の元コミット、2 Skillのファイル集合・内容hash、元側の関連文書一覧。
- 各MIG工程の変更ファイル、検証コマンド、結果、未完了事項。
- 公開後のタグ、タグが解決するコミット、Release URL、asset名、ZIPのSHA-256、再ダウンロード検証結果。

実装時は両リポジトリを書き込める作業環境を用意する。計画作成セッションの書き込み許可は元側と一時領域であり、新側とユーザーSkill配置先への書き込み許可を含まない。

既存の無関係な変更は保持する。コピー後から旧側除去までに2 Skillまたは移管対象文書が更新された場合、その差分を再移管し、更新版を公開してから除去する。元リポジトリの無関係な変更だけを理由に移行全体をやり直す必要はない。

完了条件: コピー基準と移管対象一覧が固定され、新側の既存LICENSE・Git状態を保持して作業を開始できる。

## 4. MIG-01: 新側へコピーし、単独製品の骨格を作る

### 4.1 Skill本体

次のディレクトリを同じ相対配置へコピーする。

```text
skills/igapyon-miku-scm/
skills/igapyon-github-writer/
```

初回コピー直後に、元の固定済みファイル集合と内容を照合する。`.git`、`.DS_Store`、`node_modules`、ローカル運用データは対象外。Skill配下の`docs/`、`tests/`、生成契約はコピーする。

`workplace/miku-scm/`、`workplace/github-writer/`等の実行記録、手元のdraft・承認handoff、backup・stashは移管・配布しない。GitHubで開いているIssue/PRの移動・クローズも本計画に含めない。

### 4.2 リポジトリの骨格

新側に次を用意する。

```text
README.md
INSTALL.md
DEVELOPMENT.md
TODO.md
package.json
.gitignore
docs/miku-soft-reference.md
docs/migration-from-agent-skills.md
docs/migration-execution.md
workplace/.gitkeep
scripts/
tests/
.github/scripts/
.github/workflows/
skills/igapyon-miku-scm/
skills/igapyon-github-writer/
```

- READMEはSkill-only製品であること、2 Skillの役割・起動例、対応ツール、配布・導入先を記載する。
- `docs/miku-soft-reference.md`はdeveloper skillの共有資料へのリンクとし、基本設計文書一式を複製しない。
- `.gitignore`は`bundle/`、`release-assets/`、`node_modules/`、`.DS_Store`、`.codex/`、`workplace/*`を除外し、`workplace/.gitkeep`を追跡する。
- Maven製品として初期化せず、元の`pom.xml`、みくくのVERSION、daybook向けesbuild/yaml依存を新側へ持ち込まない。
- `package.json`は`name: miku-scm-skills`、`private: true`、`type: module`とし、実際に必要な開発依存だけを追加する。npm公開はしない。
- 独立CLI向けの`bin`、空の`runtime/`、架空のupstream artifactを作らない。

### 4.3 版数を独立させる

初版はコピー基準における両Skill共通のPRODUCT_VERSIONを引き継ぐ。計画時点なら`1.20261112.4`、タグは`v1.20261112.4`とする。開始時に元側が更新されていたら、その時点の整合した値を記録して用いる。

新側は`package.json.version`を正本とし、miku-scmの`PRODUCT_VERSION`とgithub-writerの`PRODUCT_VERSION`を連動させる。元リポジトリの版数からは独立させる。`scripts/validate-version-alignment.mjs`を新側用に設け、packageと2 Skillの一致を検査する。

次の既存テストには元側の構成への依存があるので、参照と期待値を変更する。

- `skills/igapyon-miku-scm/tests/miku-scm-run.test.mjs`: root pomのartifactId/version参照を新側packageの版数へ変更。
- `skills/igapyon-github-writer/tests/github-writer-cli.test.mjs`: root pomの版数参照を新側packageの版数へ変更。
- `skills/igapyon-miku-scm/tests/miku-scm-version-alignment.test.mjs`: 新側validatorに合わせ、packageと2 Skillの一致・不一致・不正入力を検査する。

一方、Mavenリポジトリや日付連動版数を扱うmiku-scmの汎用機能・fixtureは維持する。テスト内の`pom.xml`や旧リポジトリ名を一括置換しない。

完了条件: 新側のSkillコード・テスト・検査コマンドが元側のcheckoutを必要としない。

## 5. MIG-02: 専用CI・保守資料・配備コマンドを移す

| 元側のファイル | 新側での扱い | 元側除去段階での扱い |
| --- | --- | --- |
| `.github/workflows/miku-scm-contract.yml` | コピーし、新側validator等へ接続 | 削除 |
| `.github/workflows/github-writer-contract.yml` | 同上 | 削除 |
| `.github/workflows/github-writer-benchmark.yml` | 手動実行のままコピー | 削除 |
| `.github/scripts/contract-ci.cjs` | コピーし、共有変更・版数判定を新側構成へ変更 | 他利用がないことを確認して削除 |
| `scripts/contract-ci.test.mjs` | 新側selector用に適応 | 旧selectorとともに削除 |
| `package.json`の2 Skill向けtest/benchmark scripts | 同じコマンド名で移管 | 対象scriptsだけ除去 |
| `scripts/sync-codex-skill.sh` | 汎用同期処理をコピーし、2 Skillの使い方を文書化 | 残存Skill用に保持 |
| `scripts/validate-version-alignment.mjs` | 新側packageと2 Skill用のvalidatorを作成 | pomとみくくVERSION用へ縮小して保持 |
| `scripts/skill-reference-routes.mjs` | 2 Skillの参照到達性検査を新側の配布検査へ移管 | 2 Skillのentryを除去 |

CIは既存の`pull_request`と手動実行、変更判定、最終required job、macOS/Windowsのfull検証、concurrency・timeoutを継承する。移行と同時にテストケース削減、runner統合、OS削減、大規模なテスト設計変更を混ぜない。実装時にNode.jsの保守対象、GitHub Actions各Actionの実行環境、姉妹repoの現行設定を再確認し、Node 26でmacOS/Windows full、Node 22/24でruntime smoke、Java 17でMaven fixtureという新側の構成を採用した。Actionの世代は対応要件を確認し、古い姉妹設定を機械的に複製しない。旧repoのNode 24/22設定から変わるため、実装差分と最終CI結果で妥当性を確認する。

selectorから`pom.xml`・みくくVERSION等の元側専用入力を外し、`package.json`と2つのPRODUCT_VERSIONを版数入力にする。packageのversion以外の変更、lockfileや共有build/test設定変更は必要なfullへ進める。変更一覧・内容の取得不全時は既存の保守的判定を維持する。`.github/`の独立workflow一覧も新側に存在するものへ合わせる。

selectorテストでは、対象Skill変更、共有設定変更、対象外文書変更、版数のみ変更、版数以外も含む変更、rename、取得不全、required gate失敗を検査する。新しいテストを重複追加せず、既存の意味のあるケースを適応する。

専用の設計・検証文書も新側へコピーする。最低限の対象は次のとおり。

- root `WINDOWS11-PUSH-PLAN.md`。
- `docs/plans/miku-scm-*.md`。本計画書も含む。
- `docs/plans/contract-ci-balance-plan.md`。
- `docs/plans/issues-318-400-405-luna-implementation.md`と同execution文書。
- `docs/maintenance/2026-10-30-contract-ci.md`、`docs/maintenance/github-actions-cross-platform-testing.md`。
- root TODO/DECISIONS/GOAL/HANDOFF中の、2 Skillの保守に属する決定・作業・残件。

ファイル単独で専用なら同じ相対位置を基本に移し、混在文書は該当節だけ移す。実装開始時の全文検索で対象一覧を補完する。完了履歴は履歴として保持し、未完了のWindows等の確認は未確認のまま引き継ぐ。チェックボックスだけを見て未実装へ戻さない。

参照リンクを新側の実在ファイルへ修正する。過去のIssue/PRや旧コミットを指す歴史的URLは元の宛先を維持する。

ユーザーSkillへの一方向同期は新側から`$CODEX_HOME/skills/<skill-name>`、通常は`~/.codex/skills/<skill-name>`とする。同期コマンドは次の形を維持し、導入説明に2つとも記載する。

```sh
sh scripts/sync-codex-skill.sh igapyon-miku-scm
sh scripts/sync-codex-skill.sh --check igapyon-miku-scm
sh scripts/sync-codex-skill.sh igapyon-github-writer
sh scripts/sync-codex-skill.sh --check igapyon-github-writer
```

実際のユーザー配置への同期は、依頼と書き込み許可に含まれる場合だけ実施する。移行作業自体の検証には隔離した展開先を使う。インストール済みコピーから新側への逆同期はしない。

完了条件: 新側で2 Skillの保守・CI・導入手順が完結し、旧側を参照する実行時依存がない。

## 6. MIG-03: 2 Skill入りZIPと検査を実装する

次のエントリを用意する。

| コマンド | 責務 |
| --- | --- |
| `npm run test:miku-scm:fast` / `:full` | 移管した既存suite |
| `npm run test:github-writer:fast` / `:full` | 移管した既存suite。writerのfastも全テストを走らせる現仕様なのでfullとの連続実行を避ける |
| `npm run test:ci-selector` | 移管したselector・required gateの検査 |
| `npm run test:package` | 構造・版数・ZIP内容・隔離展開後の検査 |
| `npm test` | 2 Skillのfullとrootの必要な検査を各1回実行 |
| `npm run build:bundle` | 2 Skillをcleanなstagingへ収集 |
| `npm run build:bundle:zip` | stagingを1回作り、インストール用ZIPを生成 |
| `node scripts/verify-release-zip.mjs <zip-path>` | 指定された実物ZIPを隔離展開し、内容・参照・helper動作を検査 |

`build:bundle:zip`にfull suiteを内包しない。既に検証した同じ状態でZIPを作る際にfullを繰り返さない。複数テストで同じbundle出力先を再構築する場合は直列化する。

成果物名は`bundle/igapyon-miku-scm-skills-<version>.zip`とし、ZIP内の直下を次の形にする。中間stagingは`bundle/miku-scm-skills/`でよいが、そのディレクトリ名をさらにZIP内へ重ねない。

```text
README.md
INSTALL.md
LICENSE
skills/
  igapyon-miku-scm/
    SKILL.md
    agents/、scripts/、references/、docs/、tests/など
  igapyon-github-writer/
    SKILL.md
    agents/、scripts/、references/、tests/など
```

単一Skill用starterをそのまま使わず、対象Skill名の一覧を明示して両方必須とする。片方欠落時はbuildを失敗させる。

初回移行では現行配布に合わせ、Skill内部の`tests/`や設計資料も保持する。契約generatorがcontract testの存在を検査するため、一般的な「開発ファイル除外」を一律適用しない。rootの開発用tests/docs/.githubはZIPに含めない。Skill内ファイルの整理は後続課題とする。

`.git`、`.DS_Store`、`node_modules`、`.codex`、`workplace`、Skill直下のローカルscratchは除外する。references/assetsの下にある同名fixtureを名前だけで一律除外しない。両Skillは現状index未採用なので、配布工程でindexを新設しない。

配布検査は次を満たす。

- installable Skill集合がちょうど2つで、frontmatter名とディレクトリ名が一致する。
- 配布対象のファイル集合・内容hashが新側sourceと一致し、必要な参照・生成lockが存在する。
- 元のsourceルートを使わず、指定されたZIPそのものを一時領域に展開して検査する。
- 両runnerの`--help`、`--version`、workflow discoveryが成功し、版数が一致する。
- 一時的なGit fixtureに対し、miku-scmの`repository.status`とgithub-writerの`branch.status`が動く。ネットワークや本物の対象リポジトリには接続しない。
- 片方のSkill欠落、必要helper欠落、版数不一致、余計なローカルデータ混入を検出する。

開発中は変更した領域のfast/focused検査を使う。新側の最終状態で2 Skillのfullを各1回実施し、必要な生成契約を再生成・checkする。生成済みlock/tableは手編集しない。

```sh
node scripts/validate-version-alignment.mjs --repo .
node skills/igapyon-miku-scm/scripts/miku-scm-workflow-contracts.mjs
node skills/igapyon-github-writer/scripts/github-writer-workflow-contracts.mjs
npm test
node skills/igapyon-miku-scm/scripts/miku-scm-workflow-contracts.mjs --check
node skills/igapyon-github-writer/scripts/github-writer-workflow-contracts.mjs --check
npm run build:bundle:zip
node scripts/verify-release-zip.mjs bundle/igapyon-miku-scm-skills-<version>.zip
git diff --check
git status --short
```

契約入力に変更がなければ再生成は不要。上記`<version>`は確定した正確な版数に置き換える。未実行のOSやNode版について成功と記録しない。

完了条件: 新側のfull・契約・配布検査が成功し、2 Skillを含む実物ZIPを元側のcheckoutなしで利用できる。

## 7. MIG-04: 新側で公開し、公開済み実物を検証する

`.github/workflows/release-build.yml`を追加する。共有starterを参考に、公開Releaseとタグ名を指定した手動実行を扱う。指定タグを明示checkoutし、package版数・タグ・asset名を検査する。初回は`v<package.version>`との完全一致とし、必要性のない別版数suffix対応を追加しない。

Release候補のcommit/treeが必要なCIで成功していることを確認する。タグの対象が検証済み状態と異なる場合は対象側でCIを実行する。Release workflowは版数・契約・配布検査後にZIPと`igapyon-miku-scm-skills-<version>.zip.sha256`をアップロードし、同じcommitで既に成功した両fullを無条件にもう一度実行しない。full成功の証拠がない候補は公開しない。

GitHubでの手順は次のとおり。

1. 新側の変更をレビューし、リリース対象branchへ反映する。
2. macOS/Windowsの2 Skill検証と最終required gateの成功を確認する。必要な新側rulesetには`Miku SCM required`と`GitHub Writer required`を指定し、対象外変更でskipされる個別OS jobを必須にしない。
3. 検証済み状態へタグを付け、新側Releaseを公開する。公開したworkflowによるassetアップロード完了まで待つ。
4. `igapyon-miku-scm-skills-<version>.zip`と対応するSHA-256の存在を確認する。
5. ReleaseからZIPを別の一時領域へ再ダウンロードし、SHA-256と、当該タグの配布対象sourceに対するファイル集合・内容を照合する。
6. ダウンロードしたZIPへ`verify-release-zip.mjs`を実行し、2 Skillの隔離検査を再度行う。
7. URL、タグSHA、asset名、SHA-256、検証結果を実施証跡に記録する。

別環境で生成したローカルZIPとActions ZIPのバイト一致を無条件に要求しない。公開ZIPのchecksumと、タグに含まれるsourceとの内容一致を検証する。

公開後に不具合があれば元側を保持して修正し、新版を公開する。既存Release assetを黙って上書きしたり、公開タグを移動したりしない。

**この工程の完了が、元側の除去工程に進むための必須条件である。** Releaseだけ存在する状態、Actions artifactだけ存在する状態、ローカルZIPだけ完成した状態では進めない。続くMIG-05の更新差分・必須チェック確認も満たしてから削除する。

GitHub操作の担当について: 継続利用中の`igapyon-miku-soft-developer/references/repo-operations.md`は「GitHub operations are a human responsibility.」と定め、push/tag/Release公開/asset uploadを通常は利用者担当としている。Lunaはローカル変更、ZIP、workflow、公開文面・操作手順まで準備し、通常は利用者による公開完了を待つ。後続の利用者指示でこれらの公開操作が明示的にエージェントへ委任された場合は、その指示を優先し、使用するSCM workflowのgateに従う。計画への同意や本計画書だけで、公開操作を開始しない。

## 8. MIG-05: 元側の削除前に再確認し、必須チェックを整理する

MIG-04の公開証跡を確認した後、元側の現在branch/HEAD/差分を再確認する。MIG-00で固定した2 Skillと移管文書の内容が、公開版へ取り込まれていることを照合する。追加変更があれば削除せず、MIG-01〜04へ戻る。

元側のGitHub ruleset/branch protectionに`Miku SCM required`と`GitHub Writer required`が登録されているかを確認する。登録済みなら、専用workflowを削除するPRが永久待機にならないよう、削除PRのmerge前にこの2つの旧必須チェックの登録を外すか残存CIへ置き換える。新側の検証稼働を先に確認し、無関係な保護設定は維持する。ファイルを削除しただけでGitHub側設定も変わったとみなさない。

## 9. MIG-06: 元ブランチから2 Skillと内部保守の記述を除去する

次を1つの整合した削除差分として作る。

| 対象 | 具体的な変更 |
| --- | --- |
| `skills/igapyon-miku-scm/`、`skills/igapyon-github-writer/` | 配下を除去。移行先へのstub Skillは残さない |
| 2つのcontract workflow、writer benchmark | 除去 |
| `.github/scripts/contract-ci.cjs`と`scripts/contract-ci.test.mjs` | 他consumerがないことを確認して除去 |
| `package.json` | 2 Skillのtest/benchmark scriptsを除去。daybook等のscripts/依存を保持 |
| `pom.xml` | version検査へ渡す2 Skillのパスだけを除去。pomとみくくVERSIONの整合検査は維持 |
| `scripts/validate-version-alignment.mjs` | 2 Skillの入力・結果・依存を除去。`--repo`とMavenからの呼び出しを残存2 sourceへ合わせる |
| 旧version整合テスト | pomとみくくVERSIONに属する有用なケースを`scripts/validate-version-alignment.test.mjs`へ移し、元側で実行できるentryを追加 |
| `scripts/skill-reference-routes.mjs` | 2 Skillのentryを除去。残る代表参照検査を維持 |
| `scripts/build-text-bundle-selection.sh` | github-writerの選択を除去。残る3 Skillのtext bundle生成を維持 |
| `README.md`、`src/assembly/README.md` | 2 Skillのカタログ・内部製品の詳細・旧相対リンクを除去。移行先への短い案内を設ける |
| `DEVELOPMENT.md` | 2 Skillの内部開発手順・CI説明・旧パスを除去し、配布数・text bundle選択数・代表参照数を更新 |
| rootの専用計画書・保守資料 | 新側へ移管した専用文書を除去。共有文書は該当節とリンクを整理 |
| `GOAL.md`、`TODO.md`、`DECISIONS.md`、`HANDOFF.md` | 移管済みの専用事項を整理。残存製品の記録は保持 |

元側の配布数は現在の構成なら26（内部13、外部13）、代表参照経路は12になる。実装開始時に他の追加・削除があれば実ディレクトリから再計数する。新側への外部pinは追加しない。

次の実依存は削除しない。

- daybookのIssue intakeはmiku-scmのread/comment/closeと承認・復旧規則を使う。この機能・fixtureを保持する。
- `skills/igapyon-miku-daybook/references/issue-import.md`の前提条件、および必要なREADME/INSTALL説明へ、新側からmiku-scmを別途導入する案内を加える。
- helperの探索はインストールされたSkillの指示に従う。元checkout内の絶対パスや存在しなくなる相対パスに固定しない。
- developer skill等の共有文書にある、過去の監査証跡・旧変更例は履歴として扱う。旧sourceへのリンクが必要なら固定した旧コミットへ向ける。残存Skill自体の説明やテストを一括削除しない。

`rg`で`miku-scm`、`github-writer`、両正式Skill名、削除したworkflow名を検索し、各残存箇所を「新配布先の案内」「実依存」「歴史的証跡/fixture」のいずれかとして確認する。検索結果ゼロを完了条件にしない。元側が2 Skillを内包・保守・配布しているように読める説明と、削除済みパスへの生きた参照を残さない。

ユーザーのインストール済みSkillや、対象リポジトリ内の`workplace`運用データは削除しない。旧Releaseの差し替え、元リポジトリの新Release公開はこの除去工程に含めない。

## 10. MIG-07: 元側の検証と完了報告

元側で次を実行する。削除した2 Skillのfull suiteは新側の責任であり、元側で再実行しない。

```sh
node scripts/validate-version-alignment.mjs --repo .
node --test scripts/validate-version-alignment.test.mjs
npm run test:skill-index-policy
npm run test:daybook
mvn clean package
node scripts/check-release-archive.mjs target/igapyon-agent-skills-<元側version>.zip
git diff --check
git status --short
```

元側版数は実装時のpomから取得する。既存版数・タグを黙って変更せず、版数更新が依頼されていれば元側の残存版数規則に従う。

最終ZIPは通常の内容検査に加え、2 Skillのディレクトリが存在しないことを確認する。内部13・外部13という計画時点の見込みと実際の配布集合を照合する。text bundle選択を変更したので、`sh scripts/build-text-bundle-selection.sh`も一度実行し、削除済みgithub-writerを要求せず残存3 Skillが生成されることを確認する。

daybookの参照・導入説明だけを変更した場合はmjs動作を書き換えない。adopted indexに影響する変更がある場合のみ該当indexを再生成し、既存のindex検査を通す。

削除差分をレビューし、通常のcommit/PR手順で元branchへ反映する。新側と元側の変更は別commit/PRとし、元側には公開済み移行先のURLとタグを記載する。GitHub操作はMIG-04に記載した担当・委任条件を適用する。

完了報告には以下を示す。

- 新側のcommit、Release URL・タグ、ZIP名とSHA-256、再ダウンロード検証結果。
- 新側のfull・契約・配布検査、実際に確認できたOS/Nodeの範囲。
- 元側の除去commit/PRと、残存Skillの検査・配布集合の確認結果。
- 新旧rulesetの確認・変更結果。未実施なら未完了と記載する。
- ユーザー用Skillの導入/同期を実施したか、未実施か。
- 新側へ引き継いだ未確認事項・残件。

## 11. 停止・復旧条件

- 新側のテスト・契約・配布検査が失敗したら新側を修正し、元側を保持する。
- Release/assetが未公開、取得不能、内容不一致なら元側除去へ進まない。
- コピー後に元側の移管対象が更新されたら再コピー・再検証・新版公開を先に行う。
- GitHub操作の結果が不明なら遠隔状態を確認し、重複公開・asset上書きを自動再試行しない。
- 元側除去後に回復が必要なら、対象の削除commitだけをrevertする方針とする。無関係な作業へのresetや新側Releaseの削除は行わない。

## 12. Lunaへの着手指示

後続で実装が依頼されたら、本書のMIG-00〜03を順に完了し、実物ZIPと公開手順をレビュー可能にする。MIG-04の公開と再ダウンロードの証跡が得られた場合だけMIG-05〜07へ進む。公開操作も明示的に委任されていればその依頼範囲で進め、委任されていなければ公開準備と証跡待ちの状態を具体的に報告する。

移行のための版数・参照・CI接続・配布に必要な修正へ範囲を限定し、2 Skillの機能改善、Skillの統合、独立Node CLI化、テストの追加削減を混ぜない。
