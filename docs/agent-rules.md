# Claude エージェント側の対応ルール

VK Orchestrator（オーケストレーター）経由で実行されるタスク（個別リポの issue に `task-queue` ラベル付き、[task-queue](https://github.com/vektor-inc/task-queue) リポジトリにメタ issue が存在する）に、Claude エージェント（vk-kore の司 等）が対応する際のルール。

オーケストレーターの動作仕様は [README.md](../README.md) を、ラベルの一覧は [task-queue リポジトリ](https://github.com/vektor-inc/task-queue) を参照。このファイルは「エージェントがどう振る舞うべきか」だけを扱う。

## task-queue 経由かどうかの判定

- 対象 issue に「🤖 task-queue で取り込みました → task-queue#NNN」コメントがある
- または `gh issue list -R vektor-inc/task-queue --state open --json number,title,labels` で `[<対象リポ名>] <元 issue タイトル>` のメタ issue がヒットする
- 全文検索（`--search "<repo> <issue番号>"`）は本文 URL にヒットせず取りこぼすことがあるため、タイトルでの突き合わせを使う

## automerge ラベル付きタスクではマージ判断で停止しない

メタ issue に `automerge` ラベルが付いている場合、オーケストレーターは PR の完了条件（CI 通過・CodeRabbit 静観・mergeable・非 Draft）を満たし、**かつ e2e 完了マーカーが現 head SHA に対して存在する** ときに限り squash merge する。

- **`automerge` ラベルはメタ issue（vektor-inc/task-queue 側）にのみ付く。** 対象リポ側の issue ラベルを見て「automerge なし」と結論しないこと
- automerge 対象なら、「マージ判断をお願いします」とユーザー応答待ちで **停止してはいけない**。停止するとオーケストレーターがメタ issue を `status:waiting-input` に倒し、自動マージプロセスが止まる
- CI 完了を確認して即マージ（リポの慣習に合わせる）するか、オーケストレーターの自動マージに任せる
- メタ issue が無い、または `automerge` ラベルが無い場合は通常運用（マージ判断はユーザーに委ねる）

## automerge は e2e 完了マーカーがある時のみ発火する

automerge は「CI + CodeRabbit green」で発火するため、vk-kore フローの最終レビュー・e2e（麗美 e2e）より前に走りうる。e2e で見つかるバグが入ったまま main にマージされる事故を防ぐため、オーケストレーターは **e2e 完了マーカーが現在の PR head SHA に対して存在するときだけ** 自動マージする。マーカーが無い間は失敗ではなく「保留」（次ループで再判定）であり、マーカーが付けば次ループでマージされる。

マーカーは **対象 PR** に付与する（メタ issue ではなく実 PR）。vk-kore の司は **4-8 完了（最終レビュー・e2e ゲート通過＝e2e 実施 PASS または正当なスキップ）時点で、現 head SHA に対して** 次の 2 つを付与する責務を負う:

1. PR に **`e2e-passed` ラベル** を付ける
2. PR に **`e2e-passed-sha: <現 head SHA>`** を含むコメントを投稿する（短縮 SHA でも可。head SHA への前方一致で照合される）

```bash
SHA=$(gh pr view <PR番号> -R <owner>/<repo> --json headRefOid --jq '.headRefOid')
gh pr edit <PR番号> -R <owner>/<repo> --add-label e2e-passed
gh pr comment <PR番号> -R <owner>/<repo> --body "e2e-passed-sha: $SHA"
```

- オーケストレーターはマーカーの意味を解釈せず、**`e2e-passed` ラベルと SHA 一致コメントの両方** が揃っているかだけを見る。両方が揃わない限り自動マージしない（安全側）。
- **マーカー付与後に修正 push が割り込むと head SHA が変わり、コメントの SHA と一致しなくなる** ため、自動マージは再び保留される。push したら e2e を再確認のうえ、**新しい head SHA でマーカー（ラベルは付いたままなので `e2e-passed-sha:` コメントだけでよい）を再付与** すること。

## automerge 後のクリーンアップはオーケストレーターが行う

automerge では司（vk-kore）ではなくオーケストレーターが PR をマージするため、司の手動マージ時に走る vk-kore の「マージ後の cleanup」（`vk-clean-repo` 相当の worktree・ブランチ掃除）が走らない。代わりに **オーケストレーターがマージ検知後に自動でクリーンアップする**:

- wp-env コンテナ群（コンテナ・ボリューム・ネットワーク）の destroy
- worktree ディレクトリの削除
- マージ済みローカルブランチ（PR head ブランチ）の削除

これは automerge だけでなく、GitHub UI 等による外部マージをオーケストレーターが検知した場合も同様に実行される。実行結果は対象 issue にコメントで残る。**司は automerge タスクで自分から cleanup を試みる必要はない**（手動マージしたときだけ従来どおり vk-kore 側の cleanup を実施する）。

## automerge は進行中の修正 push と競合する

オーケストレーターは CI / CodeRabbit のステータスしか見ておらず、エージェントチーム内で進行中の対応（e2e FAIL → 修正 push 等）を知らない。チェックが green になった時点で（かつ e2e 完了マーカーが現 head SHA に存在すれば）いつでもマージされうる。逆に言えば、**e2e 完了マーカーを付けない限りは green でも止まる** ので、上記の e2e ゲートが進行中の修正 push に対する第一の安全網になる。それでも次の運用は併せて守ること:

- 修正対応が残っている間は PR を **draft にしておく**
- push 後は `gh pr view --json state` で **マージ済みでないか確認** する
- マージと入れ違いになった場合は、修正コミットをデフォルトブランチ起点のブランチに cherry-pick してフォローアップ PR を作成する

## メタ issue のクローズまで責任を持つ

本来はオーケストレーターが PR マージを検出してメタ issue をクローズするが、Claude がユーザー確認待ちで止まった際に `status:waiting-input` のまま放置される経路がある。task-queue 経由のタスクと認識したら、マージ後の cleanup で下記のクローズ手順まで実施すること。

**前提チェック（手動マージ時のレース対策）**: automerge ラベル付きタスクをユーザーの明示指示で司が手動マージした場合、オーケストレーターも同じマージを検知してクローズ処理・cleanup を実行するため、司の後追い処理と競合してメタ issue に重複（本文の PR ブロック・完了コメントの2重投稿）が生じる。これを防ぐため、クローズ手順は必ず冪等に行う:

- **手順に入る前にメタ issue の state / `status:*` ラベルを確認し、既に closed または `status:done` なら以降の処理（1〜4）をすべてスキップする**（オーケストレーターが処理済みと判断）。

  ```bash
  META=$(gh issue view <N> -R vektor-inc/task-queue --json state,labels --jq '.state + " " + ([.labels[].name] | join(","))')
  # META に "CLOSED" または "status:done" が含まれていれば、以降の 1〜4 をスキップ
  ```

- スキップしない場合も、各ステップは投稿・変更前に既存の同一内容の有無を確認し、既にあれば再実行しない（下記各ステップの注記を参照）。
- cleanup（worktree・ブランチ削除）もオーケストレーターが実施しうるため、司側の cleanup は「既に無ければスキップ」の冪等前提で行う。

1. メタ issue 本文に PR URL を追記（オーケストレーターの標準形式）。**本文に既に同じ `**PR:** <PR_URL>` ブロックがあれば追記しない**

   ```bash
   CURRENT=$(gh issue view <N> -R vektor-inc/task-queue --json body --jq '.body')
   gh issue edit <N> -R vektor-inc/task-queue --body "$CURRENT

   ---

   **PR:** <PR_URL>"
   ```

2. ラベルを `status:done` に変更（remove 対象は現在付いている `status:*` ラベルを動的に取得する）

   ```bash
   CURRENT_STATUS=$(gh issue view <N> -R vektor-inc/task-queue --json labels --jq '.labels[].name | select(startswith("status:"))')
   gh issue edit <N> -R vektor-inc/task-queue --remove-label "$CURRENT_STATUS" --add-label "status:done"
   ```

3. 完了コメントを投稿（オーケストレーターと同じ文言）。**同じ PR URL を含む「✅ 完了」コメントが既にあれば投稿しない**

   ```bash
   gh issue comment <N> -R vektor-inc/task-queue --body "✅ 完了

   PR: <PR_URL> がマージされました。"
   ```

4. `gh issue close <N> -R vektor-inc/task-queue`
