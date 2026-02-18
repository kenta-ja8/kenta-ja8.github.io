---
title: "PostgreSQLパフォーマンス関連事項ピックアップ"
description: "実行計画、インデックス、メモリ設定、RLSの注意点、ページネーション、SQLの書き方まで、PostgreSQLのパフォーマンス関連事項を整理してピックアップ。"
createdAt: "2026/02/16"
heroIcon: "⚡"
tags: ["PostgreSQL", "パフォーマンス", "SQL", "Index"]
---

## ブロック

- PostgreSQLはページ（block）単位でデータを管理している
- デフォルトは8KB
- I/Oは基本ページ単位なので、同じページに目的の行がまとまっていると有利になりやすい
- Seq Scanはページを物理順に順々に読む
  - 物理順で読むためOSの先読み（read-ahead）が効きやすい点は、ランダムI/Oになりやすいインデックスアクセスより有利なことがある
- Deleteするとxmaxという更新済みというマークがされる
- Updateは古い行バージョンをxmaxとしてマークして、新しい行バージョンを追加する
- xmax が付き、かつ参照しうるトランザクションがすべて終了したと判断された際、VACUUM が空き領域としてマークする
  - 空き領域としてマークできるものをdead tupleと呼ぶ
  - 自動で行われるVACUUMはファイルサイズ自体を縮めない
- 空き領域（free space）はInsert/Updateの新しい行バージョンの置き場として再利用できる
- ただし、空き領域への埋め戻しが進むと局所性が崩れてパフォーマンスに影響することがある
  - 空き領域に収まらない場合は末尾に追記され、使用するページが増えてI/O負荷が上がる
  - 散らばった空きに埋め戻すことで局所性（created_at順、tenant_idが同時期にまとまる等）が崩れ、インデックス経由で触るページ数が増えることがある
- 物理配置を最適化する方法
  - 1. `VACUUM FULL`
    - テーブルを作り直してdead tupleを除去し、詰め直して縮める
  - 2. `CLUSTER table USING some_btree_index;`
    - テーブルを作り直しつつ、指定インデックス順に物理配置する
    - クラスタ化状態として保持できるのは1つのインデックスのみ
  - ただし、どちらもテーブルにACCESS EXCLUSIVEロックを取り、通常の読み書きが止まるため実務で利用できる場面は限られる
- 実務でよく利用される最適化
  - 1. autovacuumをチューニングして頻度/閾値を調整する
    - dead tupleの掃除と統計情報更新はするが、通常は物理的な詰め直しや縮小はしない
    - `autovacuum_naptime` 間隔（デフォルト1分）で起動検討し、各テーブルの閾値（scale factor/threshold等）で実行判断される
    - VACUUMはロックを取るが、通常のDML/SELECTを止めにくい種類（ただしDDL等とは競合しうる）
    - `autovacuum_*` 系パラメータを調整できる
  - 2. pg_repackによるオンラインで詰め直し
    - 新しいテーブル/インデックスを作り差分追従し、最後に入れ替える
    - 最後の入れ替え時などに短時間の強いロックが必要だが、停止時間を小さくしやすい
  - 3. `REINDEX CONCURRENTLY`
    - UPDATE/DELETE を繰り返すと、ページ分割が増えたりして膨らむので再構築する

## インデックスとは
- PostgreSQLには複数のインデックス方式（btree, gin など）がある
- インデックスはテーブル（heap）とは別の構造として管理される
  - 設定したカラムの値とTID（ヒープのblockとoffset）を持つ
- インデックスを増やすと SELECT は速くなりやすい一方、書き込みコストは増えやすい
  - Insert
    - 各インデックスにエントリ（キー + TID など）を追加する
  - Update
    - 通常は各インデックスに新しいエントリを追加する
    - 条件を満たすと HOT update になり、インデックスへの新規エントリ追加を省略できる
      - 更新が「そのテーブル上のどのインデックスにも影響しない」こと
      - かつ新しい行バージョンを同一 heap ページ内に置けること
  - Delete
    - エントリに対して書き換えるような仕事はしない
    - 行の特定にインデックスが使えると、インデックスがないときより削除処理が速くなることがある
- dead tupleはヒープ同様にVACUUMが空き領域に変更する
  - 対象の判定はヒープと異なり、行に更新があっても xmax はマークされていないため、ヒープを見て判断する
- トランザクションごとに見える値が異なるが、これはヒープで管理していてインデックスでは管理されていない
  - そのため visibility map をヒープが管理している
  - visibility map はページ単位で管理されていて、このページの値は全トランザクションから見える値が同じであることを判定できる
  - データ更新があると visibility map の all-visible が false になり、VACUUM が true にする
  - autovacuum はデフォルト1分ごとなので、データ更新からそれくらいの期間は true にならない
- Index Scan は、該当行数が増えるとヒープへのランダムアクセス（heap fetch）が積み重なって遅くなりやすい
  - インデックスで TID を得たあと、必要に応じてヒープへ行き visibility map を確認して列を取得する
- Index Only Scan が成立すると、ヒープアクセスを省略できて速くなりやすい
  - 参照する列がインデックス内（キー列や INCLUDE 列）にあること
  - かつ対象のヒープページが visibility map で all-visible であること
  - all-visible でないページは、ヒープに行って可視性確認が必要になる
- インデックスの TID に基づいてヒープにアクセスするのはコストが高い
  - 物理的に離れたページを読む（ランダムアクセス）ことになる
  - ランダムアクセスはプランナーのコストモデルで random_page_cost として表現され、デフォルト4
  - seq_page_cost はデフォルト1なので、ランダムアクセスは Seq Scan の4倍のコストという扱い
  - ただし、HDD時代に設定されたデフォルト値なので、SSDを使う昨今ではもっと差を縮めた方が適切という話もある

### B-treeインデックス
- デフォルトのインデックス方式
- キー（インデックス対象列の値）とTIDを保持している
- 複合インデックスができる
  - 先頭列から順に条件があるところまで使われる（leftmost prefix）
  - ORDER BY をインデックスで捌きたい場合、列ごとの並び順（ASC/DESC）が効くことがある
    - 単一列なら前/後ろスキャンで代替できることが多い
    - 複合で列ごとの向きが混在するORDER BYを狙うときは指定が必要になることがある
- 部分インデックス（partial index）
  - 対象行を絞ることで、インデックスを小さくしてキャッシュに乗りやすくすることができる
  - 例:
    - `CREATE INDEX idx_name ON tab (col) WHERE status = 'active';`
- INCLUDE
  - Index Only Scan を狙うために列を持たせる
  - 例:
    - `CREATE INDEX idx_name ON tab (key_col) INCLUDE (extra_col1, extra_col2);`
- leafページは隣接ページへのリンクを持ち、範囲スキャンで順に読むのが得意
- LIKE は固定プレフィックスがある場合に使えることがある（例: `LIKE 'abc%'`）
  - 先頭が不定（例: `LIKE '%abc'` や `LIKE '%abc%'`）は基本使えない
- 探索回数は理論上 O(log N) だが、分岐数が大きいため高さは増えにくい
  - 1ページで大量の子ポインタを持ち、どの分岐先に目的のデータがあるか探す
  - ページの読み込みに比べて、目的の分岐先探索コストは誤差なので大量にあっても影響なし
  - そのため 1000件と1億件でも、インデックスを辿る段数（root→leaf）は 3〜5 程度になり、検索における探索コストはほぼ変わらない

### GIN（Generalized Inverted Index）
- 要素（token）→ その要素を含むTID群を引けるインデックス
- 複数列のGINも作れる
- 要素ごとに登録するため、作成・更新が重いことが多い
- jsonb や配列などで使われる
- 前後LIKE検索は pg_trgm（または pg_bigm）+ GIN/GiST で高速化できる
  - pg_trgm は文字列をトライグラム（連続する3文字）に分解して検索候補を絞る
    - `'postgres'` は概念的に `pos`, `ost`, `stg`, `tgr`, `gre`, `res` のような3文字列の集合になる
    - `LIKE '%tgr%'` のように先頭が不定な検索では、`tgr` を含みそうな行（候補TID）をインデックスで集める
    - 最後にヒープを参照して `LIKE` 条件を本当に満たすか recheck する（偽陽性を除外する）

### 複数のインデックスを併用する仕組み
- Bitmap Index Scan → Bitmap Heap Scan
- 複数インデックスからTID集合をbitmap化し、BitmapAnd / BitmapOr で組み合わせてヒープアクセス対象を決める
- ただし bitmap が大きくなり work_mem に収まらない場合、bitmap が lossy（ページ単位）になり得る
  - この場合、offset までは保持できず「どのページ（block）に候補があるか」だけを保持する
  - Bitmap Heap Scan 側でそのページを読み、各タプルに対して条件を再評価（Recheck）して偽陽性を除外する

## メモリに関する話

### shared_buffers
- PostgreSQL内部の共有バッファ（キャッシュ）
- キャッシュの単位はページ（通常 8KB）
- SELECT の2回目以降の実行が速い場合は、shared_buffers（または OS のページキャッシュ）が効いているケースが多い
- 空きがなければ概ね古いページから追い出される
- デフォルト値は一般に 128MB
- Cloud SQL の shared_buffers デフォルトは「インスタンス総メモリの 1/3」
  - [データベース フラグを構成する | Cloud SQL for PostgreSQL | Google Cloud Documentation](https://docs.cloud.google.com/sql/docs/postgres/flags?hl=ja)
- チューニングはRAM * 25% が目安
  - [How to tune PostgreSQL for memory | EDB](https://www.enterprisedb.com/postgres-tutorials/how-tune-postgresql-memory)
- SELECT だけでなく INSERT/UPDATE/DELETE でも、対象ページは shared_buffers 上で読み書きされる
- heap だけでなくインデックスページも shared_buffers に載る

### work_mem
- Sort / Hash で使う作業メモリ上限
- クエリ単位ではなく、実行計画の各オペレーション単位で消費される
  - 並列実行では worker ごとにも発生しうる
- 上限を超えると一時ファイル（temp）に spill する
- クエリ（オペレーション）が終わると解放される
- デフォルト値は 4MB（Cloud SQL でもデフォルトは 4MB）
- チューニングはRAM * 0.25 / max_connections が目安
  - ただし実際は「同時実行数 × オペレーション数」で膨らむので、上げすぎは OOM の原因になり得る

### hash_mem_multiplier

- ハッシュ系オペレーション（Hash Join / Hash Aggregate など）のメモリ上限を計算する係数
- 上限は `work_mem * hash_mem_multiplier`
- デフォルトは 2.0
  つまり、ハッシュ系は work_mem の2倍まで使える

## JOINアルゴリズムの選択肢

- PostgreSQLはJOINを実行するとき、代表的に次の3つのアルゴリズムを選ぶ

### Nested Loop Join（NLJ）

- 外側テーブルの各行に対して、内側を探しに行く方式
- 最悪計算量は O(M * N) だが、内側の結合キーにインデックスが効く場合は O(M * log(N))
- 強いケース
  - 絞り込みが効いて外側の行数が少ない
  - 内側のJOINキーに良いインデックスがある
- 弱いケース
  - 外側が巨大で内側探索が大量に発生する
  - 内側が Seq Scan になっていて外側×全件探索になってしまう
- 相関サブクエリや JOIN LATERAL は、parameterized な NLJ になりやすい

### Hash Join
- 片側（通常は小さい側）をハッシュ表（Build）にして、もう片側（Probe）で突き合わせる方式
- 等価結合（=）が基本
- 計算量は平均的に O(M + N)
- Build が完了するまで join 結果を返せないため、最初の1行の返却は遅くなりやすい
- work_mem / hash_mem_multiplier の影響を受け、メモリに乗らないと temp に spill して遅くなる
- 強いケース
  - 等価結合（=）
  - インデックスが弱い/使いづらいが、片側をメモリに載せられる
- 弱いケース
  - ハッシュ表が大きく temp に spillする
    - uuidがjoin keyでデフォルト設定の場合、10万行くらいの規模で発生
  - 片側が極端に偏った分布で効率が落ちる
- 事前にレコード数の絞り込みができると、build対象が減って spill 回避に効く
- 「小さい側 + 大きい側」の結合でよく選ばれやすい

### Merge Join

- 両側が join key でソート済み（またはソートできる）なら、マージしながら結合する方式
- ソート済み入力なら O(M + N)。未ソートなら O(M * log(M) + N * log(N))
- 等価結合（=）に限らず、大小比較を含む結合でも使える場合がある
- ソートが必要な場合は最初の1行が遅くなりやすい
- Sort 自体も work_mem の影響を受け、溢れると temp に spill して遅くなる
- 強いケース
  - 両側が join key 順で既に並んでいる
    - 例：適切な Index Scan で順序を作れる、または事前にソート済み
  - 大きめの入力同士でも、順序が作れる/維持できる
- 弱いケース
  - 片側または両側のソートが重い
    - spillしやすい、あるいはソート対象が大きい
- 最終 ORDER BY と join key が一致する場合、merge join が順序を活かせて有利になることがある

### それぞれのコスト

- プランナーは、推定行数（統計）・コスト（I/O/CPU）・利用できるインデックス・入力の順序・メモリ（work_mem等）・結合条件の種類を見て選択する
- テーブルで選択性が低い場合は Nested Loop が有利になりやすい
- 一定ラインを超えると Hash Join が有利
  - ハッシュ表がメモリに乗らなくなると temp を使う必要があり遅くなる
  - Merge Join と比較して有利なのは、Merge Join でインデックスとヒープへのアクセスコストがかさむ場合
- さらに選択性が上がると Merge Join + インデックスが有利
- [Nested Loop/Hash/Sort Merge結合の違いとパフォーマンス比較](https://zenn.dev/loglass/articles/84f15be9a4d2c9)

## イテレーティブに取得できるか

- 実行計画の各ノードは「上流から行を受け取り、下流へ行を返す」
- time to first row と time to total rows の差は、主にストリーミング/ブロッキングと、Top-N ができるかで決まることが多い
- パフォーマンス向上のためには早期終了を狙う
  - ストリーミングに流せる形にする
  - `ORDER BY ... LIMIT N` では、できるだけ Sort を発生させず「インデックスの順序で取り出して N 件で止める」形を狙う
    - Sort ノードが出る場合、`Sort Method: top-N heapsort` になることがある
      - 全件ソートよりメモリ効率は良いが、入力は最後まで読むため、早期終了にはなりにくい
    - インデックスですでに ORDER BY の順序を満たせる場合、Sort ノード自体が表示されず `Limit -> Index Scan` の形になり、N 件で早期終了しやすい

### Streaming（入力が完了していなくても出力できる）
- Seq Scan / Index Scan / Index Only Scan
  - 1行ずつ読みながら返せる
- Filter
  - 入力1行に対して条件を評価し、通れば返す
- Nested Loop Join
  - 外側で1行取れたら内側を回して結合結果を返せる（外側0行なら内側は回らない）
- Merge Join（入力が join key 順に揃っている場合）
  - 入力をなめながら突き合わせて返せる
  - join key の順序を Index Scan で作れると、下流の Sort を避けられて有利
- Limit
  - 目的行数に達したら上流への要求を止められる（早期終了）

### Blocking（入力をある程度/全部処理しないと出力できない）
- Sort
  - 基本は入力を読んでから出力する
- Hash Join（Build側）
  - Build側を読み切ってハッシュ表を作るまで、結合結果を返しにくい
- HashAggregate
  - GROUP BY のキーごとに集約状態をハッシュ表で持つ方式
  - 入力を読みつつ状態を作り、完了後に出力することが多い
- WindowAgg
  - パーティション単位で貯めが必要になりやすい

### 入力順序に依存してストリーミング可能（Semi-blocking）
- GroupAggregate
  - 入力が GROUP BY キー順なら、グループ境界ごとに出力できる
  - 入力が並んでいない場合は Sort が必要になり、結局ブロッキングになる
  - GROUP BY キー順を Index Scan で作れると有利
- Unique
  - 入力がソート済みなら逐次で可能
  - 未ソートなら Sort または Hash が必要でブロッキング化
- Merge Append
  - 子がそれぞれソート済みなら逐次でマージできる
  - 子側でソートが必要なら下流がブロッキングになる
- Materialize
  - 初回は子の出力を流しながら返しつつ、同時にバッファに記録するのでストリームになる
  - 親が再走査を要求すると、同じ入力範囲をもう一度返す必要が出る
    - 必要な範囲がすでにバッファ済みなら、バッファから即座に返せる
    - まだバッファに無い範囲を2回目が要求すると、初回でその範囲が読み込まれてバッファされるまで待つことになり、ブロッキング寄りに見える
  - join key の重複が多い Merge Join などでは、同一キー範囲の再走査が増え、影響が目立ちやすい

## カラムに格納するデータ量が大きい場合

- 大きい列（長文・JSON・バイナリなど）を頻繁に読むと I/O とキャッシュ圧迫の原因になりやすい
- 対策としては外部ストレージに本体を置き、DBには参照（URL/キー）とメタデータだけを持たせる
- TOAST による影響の緩和
  - PostgreSQLは行が大きい場合、値を圧縮したり、別テーブル（TOASTテーブル）へ退避して保持することがある
  - 大きい列を参照しない（SELECT句に含めない／WHERE等で使わない）なら、その列の「中身」を取りに行かずに済む
    - つまりヒープ側の行は読むが、TOASTテーブル側のページ読み込みを避けられ、キャッシュ圧迫を抑えやすい
- 運用目安
  - 数十KB以上の列を頻繁に読む設計は要注意
  - 数百KB〜MB級をDBに保持・配信するなら、外部ストレージを検討するケースが多い
- UTF-8テキストサイズの概算
  - 英文：1KB ≈ 1000文字
  - 日本語：1KB ≈ 300文字程度

## IDをUUIDv4でなく連番にする方が有利になりやすい

- 直接的に書き込み、間接的に読み込み面において、連番の方が有利になりやすい
- IDと異なり、UUIDv4はランダムなID
- 連番（bigint等）にするメリット
  - 単調増加キーはB-treeの右端付近への挿入になりやすく、局所性が高い
    - ページ分割は避けられないが、右端近辺で起きやすく「分割が全体に散りにくい」
    - 過去のページにランダムに挿入が戻りにくいため、同じページが何度も再分割される状況が起きにくい
    - 結果として、インデックスの肥大や書き込みI/Oが抑えられやすい
    - 更新で触るインデックスページも右端近辺に偏りやすく、shared_buffers に載るページが局所化しやすい
  - bigint（8バイト）はUUID（16バイト）よりキー幅が小さいので、インデックスが小さくなりやすく、キャッシュ効率やI/O効率が良くなりやすい
- 連番にするデメリット/注意点
  - 連番は推測しやすい（ID enumeration）
    - 対策：外部公開用のIDを用意する、APIではUUID/ランダムIDを使う等
  - 単調増加キーは rightmost page contention（右端リーフ集中による競合）が起き得る
    - 書き込みが非常に多い場合にボトルネックになりうる
    - 1000 insert/s くらいでは注意
  - シャーディング時はID採番方式の設計が必要
- UUIDの影響はMySQLより限定的
  - MySQL（InnoDB）は PK 順にデータを配置するため、ランダム PK はテーブル本体の分割・断片化にも直撃しやすい
  - PostgreSQLはテーブル本体が PK 順に並ばないため、ヒープは影響を受けにくい
- UUIDv7での緩和
  - UUIDv7は生成順が概ね単調増加なので、UUIDv4よりはB-treeの局所性が改善しやすい
  - ただし単調増加に寄る分、右端集中（競合）が連番に近づく可能性もある

## ページネーション

- 必要なデータだけ取得し、早期終了（Top-N）できる形に寄せたい
  - `ORDER BY ... LIMIT N` をインデックスの順序で満たせると、Sortを避けつつ N 件で止めやすい
- LIMIT/OFFSET は offset が大きいほど無駄が増えやすい
  - `OFFSET 1000 LIMIT 10` は「最初の1000件を捨ててから10件返す」必要がある
  - 特に `ORDER BY` や JOIN が絡むと、捨てるための処理コストが重くなりやすい
  - 後半ページほど遅くなりやすい
- 総件数（Total）はコストが高くなりやすい
  - COUNT(*) は結果行を返さないが、条件に合う行数を数えるために多くの行を走査する必要が出やすい
  - JOIN や条件が複雑だと、集計のためのコストが大きくなりやすい
- カーソルページネーションを使い、「最後に見た位置」から次の N 件を取る方が望ましい
  - offset のように前方を捨てないので、後半ページでも一定のコストになりやすい
  - 順序は安定にする（同値のタイブレークが必要）
    - 例：`ORDER BY created_at DESC, id DESC`
    - 例：`WHERE (created_at, id) < (:cursor_created_at, :cursor_id)`
- 実務で総件数（Total）をどう扱うか
  - そもそも表示しない
  - 統計情報から概算を出す（正確性は保証しない）
  - 「100件以上なら 100+」のように上限付きで判定する
  - 別 API にして遅延表示する
- [Pagination and the problem of the total result count](https://www.cybertec-postgresql.com/en/pagination-problem-total-result-count/)

## ビューについて

- 通常の View は定義クエリが実行時に展開されるため、基本はクエリを直接書くのと同等になりやすい
- マテリアライズドビューは結果を物理的に保存する
  - 読み取りは速くなりやすいが、再計算が必要
  - 再計算は明示的に実行する
    - `REFRESH MATERIALIZED VIEW my_mv;`
    - 元テーブル更新と同一トランザクションでREFRESHすること自体は可能だが、通常はバッチ等で更新することが多い
  - マテリアライズドビューにはインデックスを作成できる
  - REFRESH時のロック
    - `REFRESH MATERIALIZED VIEW`（CONCURRENTLYなし）は `ACCESS EXCLUSIVE` を取り、SELECTも含めてブロックされる
    - `REFRESH MATERIALIZED VIEW CONCURRENTLY` は `EXCLUSIVE` を取り、SELECT（ACCESS SHARE）は並行実行できる（更新系はブロックされる）
    - `CONCURRENTLY` を使うには、マテビューに「WHEREなしの一意インデックス」が必要
  - 速度感
    - `CONCURRENTLY` なしは結果を作り直して入れ替える動きになり、実質「全件作り直し」
    - `CONCURRENTLY` ありも、元クエリの結果生成は基本フルで行い、差分適用で入れ替える
      - ケースによっては全件作り直しより早い

## パーティションについて

- パーティションは大きなテーブルを分割して管理する方法
  - 主な狙いは、条件に合わないパーティションを読まない（partition pruning）ことと、運用/メンテナンスを楽にすること
  - ただしパーティション数が多すぎるとプランニングコストが増えるなど、逆効果になり得る
- パーティションは基本、運用として事前に作成しておく
  - 例：年次・月次でレンジパーティションを切るなら、翌年/翌月のパーティションを事前に作る
  - default partition を用意して「どこにも属さない行」を受ける設計にしておくこともできる（後追い作成の逃げ道）
- ハッシュパーティションも使える
  - 特定のキー（例：tenant_id）をハッシュしてパーティションに振り分ける

## CTE の MATERIALIZED / NOT MATERIALIZED

- CTE（Common Table Expression）は実行計画上「インライン化するか」「中間結果として固定するか」を制御できる
  - `WITH tmp AS MATERIALIZED (...)` / `WITH tmp AS NOT MATERIALIZED (...)`
- NOT MATERIALIZED
  - CTE を親クエリへインライン展開し、外側の条件や LIMIT なども含めて最適化されやすい
  - predicate pushdown（外側条件の押し込み）や早期終了が効きやすい
- MATERIALIZED
  - CTE の結果を一旦作って固定し、後続はその結果を読む
  - 外側の条件をCTE内に押し込めないため、predicate pushdown が効かない
  - 外側に LIMIT があっても、CTE側を先に作り切ってしまい早期終了が効かないケースがある
  - CTE の中間結果に対して通常インデックスは無いので、
    「複合インデックスの条件をCTE内外に分割して効かせる」ことはできない
    - 例：元テーブルに index(a, b) があっても、CTE内で a を絞り、CTE外で b を絞る最適化は期待できない（b 条件を CTE 内へ押し込めないため）
- 明示しない場合
  - PG12以降、通常のCTEはインライン化され得る（NOT MATERIALIZED 的）
  - ただし再帰CTE、インライン化で意味が変わり得る場合（例：volatile関数を含む等）、参照回数が多く再計算が重い場合などは materialize され得る
- 使い分けの観点
  - 外側の WHERE / LIMIT を効かせたい → NOT MATERIALIZED を検討
  - CTEを複数回参照し、再計算を避けたい → MATERIALIZED を検討
  - 正規表現・JSON走査・UDFなどは推定が外れやすいので、必要に応じて MATERIALIZED/NOT MATERIALIZED を明示して挙動を固定する

## Generic Plan / Custom Plan

- prepared statement（パラメータ付き）の実行では、Generic Plan と Custom Plan のどちらを使うかが選ばれる
  - `plan_cache_mode` で強制もできる
    - `SET plan_cache_mode = force_generic_plan;`
    - `SET plan_cache_mode = force_custom_plan;`
- Custom Plan
  - 実行時に渡されたパラメータ値を前提にプランを作る
  - 値に合わせた選択性推定が効きやすい
  - その代わり、実行ごとにプランニングコストが乗る
- Generic Plan
  - パラメータ値に依存しない形でプランを作り、それを再利用する
  - プランニングコストを節約できる
  - 値の偏りが大きいクエリだと、Custom Plan より遅くなることがある
- どちらが使われているかの確認
  - Generic Plan が使われている場合は実行計画に `$1` などのパラメータ記号が残る
  - Custom Plan が使われている場合は具体的な値が見える
- 自動選択の大まかな挙動
  - 最初の5回の実行は Custom Plan を使い、推定コストの平均を取る
  - 次に Generic Plan を作り、その推定コストと比較する
  - Generic Plan のコストが平均 Custom Plan コストより十分に悪くなければ、以後 Generic Plan を使う
  - 一度選ばれた方針は同一セッション中は基本維持される
    - ただし無効化で再計画が走ることはある

## ショートサーキット

- プログラミング言語では `cond1 && cond2` のように左から順に評価され、`cond1` が false なら `cond2` を評価しない（短絡評価）がある
- SQL は宣言的で、WHERE句などの条件が「左から順に評価される」ことは保証されない
  - どの条件を先に評価するかは、プランナーが実行計画として決める
  - そのため「重い条件を後ろに書けば回避できる」等は保証できない
- One-Time Filter
  - あるプランノードが動き始めるタイミングで “1回だけ” 評価される条件が、実行計画に `One-Time Filter:` として表示されることがある
  - One-Time Filter が false になると、そのノード配下の処理が実行されず、重い処理を回避できる場合がある
  - `SELECT ... FROM ... WHERE CURRENT_DATE = DATE '2018-12-01' AND <heavy_condition>;`
    - 先頭の条件がノード開始時に一度評価され、false なら `<heavy_condition>` 側が回らない形になることがある
- さらに単純な定数条件（例：`1=2`）は、最適化で消されて実行計画が大きく簡略化されることがある
  - 結果として「その条件が実行計画に見えない」ことがある
- [PostgreSQL の実行計画に現れる One-Time Filter の読み解き方 - ぱと隊長日誌](https://taityo-diary.hatenablog.jp/entry/2018/11/20/062805)

## Row Level Security（RLS）利用時、LIKE/ILIKE でインデックスが効かないことがある

- RLSが有効なテーブルは、セキュリティ上の理由で「RLSのフィルタより前に、危険な演算子/関数を評価しない」制約がかかる
- `LIKE/ILIKE` は内部的に使う演算子/関数が `LEAKPROOF` ではないため、RLSのフィルタより先に評価できない
  - その結果、インデックスが用意されていても、プランナーがインデックススキャンを選べず Seq Scan などになることがある
- [Vol. 01〖PostgreSQL〗わたしのクエリ、遅すぎ...？Row Level Securityに潜むLEAKPROOFの罠 - Sansan Tech Blog](https://buildersbox.corp-sansan.com/entry/2024/11/28/130000)


## パフォーマンス向上のためのSQL書き方

### EXISTS / LIMIT 1 を使って「1件見つかったら終わり」
- 存在チェックは COUNT(*) ではなく EXISTS が定番
- EXISTS は「1件でも見つかれば true」でよいので、実行側が早期終了できる計画になりやすい（特に内側にインデックスがあると効きやすい）

```sql
SELECT EXISTS (
  SELECT 1
  FROM t
  WHERE tenant_id = $1 AND status = 'active'
);
```

### Top-N（ORDER BY ... LIMIT n）を「Sortなし」で終わらせる
- ORDER BY ... LIMIT は、並び順に合うインデックスがあると Index Scan で上から n 件だけ取って終了できる
- インデックスで順序を満たせないと Sort が入る
- top-N heapsort になることはあるが、入力は最後まで読むことが多くブロッキング寄りになりやすい

```sql
SELECT *
FROM events
WHERE tenant_id = $1
ORDER BY created_at DESC
LIMIT 10;
```

### 「親1行につき子を1行だけ」なら LATERAL + LIMIT 1

- JOINしてから max() / window で「最新1件」を取ると、子側を大量に読んでしまいがち
- 親ごとに子を「先頭1件だけ」取りにいく形にすると、子側のインデックスで早期終了できることがある
- 親の行数が多いと子の探索回数も増えるので、親側の絞り込みと子側インデックスが重要

```sql
SELECT p.id, c.*
FROM parent p
LEFT JOIN LATERAL (
  SELECT *
  FROM child c
  WHERE c.parent_id = p.id
  ORDER BY c.created_at DESC
  LIMIT 1
) c ON true
WHERE p.tenant_id = $1;
```

### OR を UNION ALL に分解して「排他的な分岐」を作る

- OR が絡むとアクセス戦略が妥協されやすいことがある
- 条件が排他的なら、UNION ALL に分解すると片側はインデックスを素直に使える
- もう片側は One-Time Filter などで丸ごと実行されない形になりやすい
- [PostgreSQL: Re: Prepared statement's planning](https://www.postgresql.org/message-id/25294.1200416313%40sss.pgh.pa.us)

```sql
-- $1 が NULL のときは全件、NULLじゃないときは user_id で絞る

-- Bad
SELECT *
FROM events
WHERE $1 IS NULL OR user_id = $1;

-- Good
-- 互いに排他的になるように分解（$1 IS NULL と $1 IS NOT NULL）
SELECT *
FROM events
WHERE $1 IS NULL
UNION ALL
SELECT *
FROM events
WHERE $1 IS NOT NULL
  AND user_id = $1;

```

### COUNT/GROUP BY を避けて「N件目の存在」だけを見る

- 「N件以上あるか」を知りたいだけなら、全件数を数えるより「N件目が存在するか」を見る方が軽いことがある

```sql
-- 3件以上ある cluster_id を列挙

-- Bad
SELECT cluster_id
FROM nodes
WHERE active
GROUP BY cluster_id
HAVING COUNT(*) >= 3;

-- Good
-- clusters を返したい場合：各 cluster について「active node が3件目まで存在するか」を見る
SELECT c.id
FROM clusters c
WHERE EXISTS (
  SELECT 1
  FROM nodes n
  WHERE n.cluster_id = c.id
    AND n.active
  OFFSET 2 LIMIT 1   -- 0,1,2 の3件目が取れたら「3つ以上」
);
```

## 参考
- [B-Treeのアーキテクチャ解説 (第49回PostgreSQLアンカンファレンス@東京 発表資料) | PDF](https://www.slideshare.net/slideshow/postgresql-btree-architecture-pgunconf49-nttdata/272447687)
- [とあるクエリを2万倍速にした話 -データベースの気持ちになる- 前編 - dwango on GitHub](https://dwango.github.io/articles/mastodon-database-index-1/)
- [〖PostgreSQL〗パフォーマンス改善事例:大規模テーブル結合の最適化｜Ｓｋｙ Tech Blog（スカイ テック ブログ）](https://www.skygroup.jp/tech-blog/article/1904/)
- [SQL初心者がPostgreSQLのクエリパフォーマンス改善してみた - TECHSCORE BLOG](https://blog.techscore.com/entry/2024/12/11/080000)
- [PostgreSQLの実行計画を読む - GO Tech Blog](https://techblog.goinc.jp/entry/2023/12/06/090000_2)
- [PostgreSQLでクエリの実行計画を見る - もふもふ技術部](https://www.mof-mof.co.jp/tech-blog/2024/06/21/180240)
- [PostgreSQL: 4億件のテーブルでSeq Scanが選ばれる問題を、統計情報(n_distinct)の改善で解決するまでのプロセス | フューチャー技術ブログ](https://future-architect.github.io/articles/20251010a/)
- [PostgreSQL を使ったユーザー検索機能のパフォーマンス改善の話 - エムスリーテックブログ](https://www.m3tech.blog/entry/2025/07/29/173948)
- [PostgreSQLがPGroongaのインデックスを使ってくれないときのチェックポイント - 2024-10-25 - ククログ](https://www.clear-code.com/blog/2024/10/25/check-points-use-pgroonga-index.html)
- [PostgreSQLフルテキスト検索の実装でメール検索を最大71%高速化した話](https://zenn.dev/91works/articles/8659a8cfb95b72)
- [Explaining Explain PostgreSQLの実行計画を読む](https://lets.postgresql.jp/sites/default/files/2016-11/Explaining_Explain_ja.pdf)
- [Explain EXPLAIN EXPLAIN を使ったPostgreSQLのクエリ最適化の基本と実践](https://speakerdeck.com/keiko713/explain-explain?slide=5)
