---
title: "Apple ヘルスケアデータを Grafana で可視化する"
description: "iPhoneのショートカットでヘルスケアデータを収集し、Grafanaで可視化するまでの手順をまとめました。"
createdAt: "2025/10/15"
heroIcon: "📊"
tags: ["iPhone", "Apple Health", "Shortcuts", "Grafana"]
---

# はじめに

Appleヘルスケアに蓄積されたデータをGrafanaで可視化しました。  
ヘルスケアデータを取得する公式のWeb APIは提供されていないため、iPhoneから定期的にデータを取り出してサーバーへ送る仕組みが必要です。  
今回はショートカットアプリを利用し、自宅サーバーにデータをPOSTする構成にしました。

<img src="/blog/0009-healthcare/grafana.png" alt="Grafana" />

# ヘルスケアデータの収集方法

## 収集の方針

ショートカットには定時実行の仕組みがありますが、ヘルスケアデータの取得はバックグラウンドでは動作しません。  
そのため、iPhoneで特定のアプリを開いたことをトリガーにショートカットを起動する方針にしました。  
ヘルスケアデータは共通で`value`・`startDate`・`endDate`・`type`・`unit`・`name`・`source`・`duration`といった項目を持つため、これらをまとめてサーバーに送信します。  
サーバー側ではJSONを受け取り、PostgreSQLに保存できるようにし、`startDate`・`value`・`source`の組み合わせで存在チェックを行って重複登録を防いでいます。

## ショートカットの詳細設定

### データ送信のメインロジック

- 直近1日分のデータをまとめて送信するように設定しています
- `Repeat with each item`アクションで取得データをDictionaryに整形しています
  - データが1件だけの場合は配列でなく単一のDictionaryになるため、デバッグ時には注意が必要です
- 送信先URLは別のショートカットで管理し、必要なときに参照しています
- `Get contents of URL`アクションでPOSTリクエストとしてサーバーに送信しています
  - フォーム形式は`File`を選択してDictionaryを添付しています
  - ios26.0.0時点では`JSON`形式を選ぶとDictionaryを直接設定できない挙動でした

<img src="/blog/0009-healthcare/active-energy-collector1.png" alt="ActiveEnergyCollector1" width="250" />
<img src="/blog/0009-healthcare/active-energy-collector2.png" alt="ActiveEnergyCollector2" width="250" />
<img src="/blog/0009-healthcare/active-energy-collector3.png" alt="ActiveEnergyCollector3" width="250" />

### トリガー用エントリーポイント

- このエントリーポイントをChromeなどの特定アプリを開いたときに実行しています
- 最終実行日時を保存し、前回から10分以上であれば実行するようにしています
  - この判定がないとアプリを開くたびにデータを送信してしまいます
  - 最終実行日時は「Jar」というアプリに保存しています
- 接続中のネットワークを確認し、自宅ネットワークに接続されている場合だけ実行しています
  - 外出先でサーバーへデータを送らないためです
- 条件を満たした場合に各データ取得ショートカットを順番に呼び出しています

<img src="/blog/0009-healthcare/collector-main1.png" alt="CollectorMain1" width="250" />
<img src="/blog/0009-healthcare/collector-main2.png" alt="CollectorMain2" width="250" />
<img src="/blog/0009-healthcare/collector-main3.png" alt="CollectorMain3" width="250" />

# Grafanaでの可視化

## Active Energy

`value`に消費カロリー、`startDate`（`start_time`）に記録日時が入っているので、これらを使ってグラフ化しました。  
日単位で集約しつつ、データがなければ0で埋めています。  
Time Seriesパネルは以下のSQLで取得しています。

```sql
WITH bounds AS (
  SELECT
    $__timeFrom() :: timestamptz - interval '30 day' AS from_ts,
    $__timeTo() :: timestamptz AS to_ts
),
days AS (
  SELECT
    generate_series(
      date_trunc('day', (from_ts AT TIME ZONE 'Asia/Tokyo')),
      date_trunc('day', (to_ts AT TIME ZONE 'Asia/Tokyo')),
      interval '1 day'
    ) AS day_local
  FROM
    bounds
),
agg AS (
  SELECT
    date_trunc('day', (start_time AT TIME ZONE 'Asia/Tokyo')) AS day_local,
    SUM(value) AS sumv
  FROM
    h_active_energies
  WHERE
    start_time BETWEEN (
      SELECT
        from_ts
      FROM
        bounds
    )
    AND (
      SELECT
        to_ts
      FROM
        bounds
    )
  GROUP BY
    day_local
),
padding AS (
  SELECT
    day_local as time,
    COALESCE(agg.sumv, 0) AS value,
    AVG(sumv) OVER (
      ORDER BY
        day_local ROWS BETWEEN 13 PRECEDING
        AND CURRENT ROW
    ) AS "MA(14)"
  FROM
    days
    LEFT JOIN agg USING (day_local)
  ORDER BY
    time
)
SELECT
  *
FROM
  padding
```

Statパネルは次のSQLで最新2日分を取得しています。

```sql
WITH b AS (
  SELECT
    $__timeFrom() :: timestamptz AS from_ts,
    $__timeTo() :: timestamptz AS to_ts
),
days AS (
  SELECT
    generate_series(
      date_trunc('day', (from_ts AT TIME ZONE 'Asia/Tokyo')),
      date_trunc('day', (to_ts AT TIME ZONE 'Asia/Tokyo')),
      interval '1 day'
    ) AS day_local
  FROM
    b
),
agg AS (
  SELECT
    date_trunc('day', (start_time AT TIME ZONE 'Asia/Tokyo')) AS day_local,
    SUM(value) AS sumv
  FROM
    h_active_energies
  WHERE
    $__timeFilter(start_time)
  GROUP BY
    day_local
),
padding AS (
  SELECT
    day_local as time,
    COALESCE(agg.sumv, 0) AS value
  FROM
    days
    LEFT JOIN agg USING (day_local)
  ORDER BY
    time
)
SELECT
  *
FROM
  (
    SELECT
      *
    FROM
      padding
    ORDER BY
      time desc
    LIMIT
      2
  ) as xxx
ORDER BY
  time;
```

## Sleep

`value`にステージ名、`startDate`（`start_time`）に記録開始日時、`duration`に睡眠時間が入っているため、それぞれを利用してグラフ化しました。  
ステージは `Core` + `Deep` + `REM` を `Asleep` とみなして集計しています。
12:00〜36:00の時間帯に記録された`duration`は24:00として表示するように集約しています。

```sql
WITH rng AS (
  SELECT
    $__timeFrom() :: timestamptz - interval '30 day' AS warm_from_ts_utc,
    $__timeTo() :: timestamptz AS to_ts_utc
),
bounds AS (
  SELECT
    ((warm_from_ts_utc AT TIME ZONE 'Asia/Tokyo')) :: date AS start_day_jst,
    ((to_ts_utc AT TIME ZONE 'Asia/Tokyo')) :: date AS end_day_jst
  FROM
    rng
),
days AS (
  SELECT
    generate_series(start_day_jst, end_day_jst, interval '1 day') :: date AS day_jst
  FROM
    bounds
),
agg AS (
  SELECT
    date(
      (start_time AT TIME ZONE 'Asia/Tokyo') + interval '12 hours'
    ) AS bucket_day_jst,
    SUM(
      CASE
        WHEN value IN ('Core', 'REM', 'Deep') THEN duration_seconds
        ELSE 0
      END
    ) AS asleep_seconds,
    SUM(
      CASE
        WHEN value = 'Deep' THEN duration_seconds
        ELSE 0
      END
    ) AS deep_seconds
  FROM
    h_sleep_records
  WHERE
    start_time BETWEEN (
      SELECT
        start_day_jst
      FROM
        bounds
    )
    AND (
      SELECT
        end_day_jst
      FROM
        bounds
    )
  GROUP BY
    1
),
padding AS (
  SELECT
    (day_jst :: timestamp AT TIME ZONE 'Asia/Tokyo') AS t_jst_midnight,
    COALESCE(a.asleep_seconds, 0) AS asleep_seconds,
    COALESCE(a.deep_seconds, 0) AS deep_seconds
  FROM
    days d
    LEFT JOIN agg a ON a.bucket_day_jst = d.day_jst
)
SELECT
  $__time(t_jst_midnight),
  asleep_seconds AS asleep,
  deep_seconds AS deep,
  AVG(asleep_seconds) OVER (
    ORDER BY
      t_jst_midnight ROWS BETWEEN 13 PRECEDING
      AND CURRENT ROW
  ) AS "asleep MA(14)"
FROM
  padding
ORDER BY
  t_jst_midnight;
```

# 感想

バックグラウンドで動かせないのが不便で、ショートカット実行中に画面をオフにするとヘルスケアデータ取得のタイミングで処理が止まります。  
画面を再点灯すると「ヘルスケアデータを取得するにはタップしてください」といったダイアログが表示され、承認しないと再開しない点が煩わしいです。  
また、`Repeat with each item`の処理が体感で1分ほどかかっており、全体として処理が遅いです。  
それでも目指していた可視化は実現できたので満足しています。
