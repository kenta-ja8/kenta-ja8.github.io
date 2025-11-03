---
title: "自宅KubernetesでPostgreSQLを18へアップグレードした記録"
description: "pg_upgrade を使って自宅クラスタの PostgreSQL を 15 から 18 に移行した手順のまとめです。"
createdAt: "2025/11/29"
heroIcon: "🐘"
tags: ["k8s", "PostgreSQL"]
---

## はじめに

自宅クラスタで運用している PostgreSQL を 15 から 18 にバージョンアップした手順をまとめました。
pg_upgrade を利用してダウンタイムを抑えつつ移行した際の気づきを記録しています。

## 方針

バックアップを取得して新しいクラスタにリストアする方法でも移行できますが、データ量が多いと復元に時間がかかりダウンタイムも伸びてしまいます。
自宅用途のデータベースなのでデータボリュームは大きくありませんが、短時間で切り替えられる方法を確認するために pg_upgrade を選びました。
今回は手動でコマンドを実行しています。

## 手順

### 作業用 Pod を用意する

移行作業用の Job を作成し、既存のデータディレクトリをマウントします。

```yaml:pg-upgrade-shell.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: pg-upgrade-shell
  namespace: app
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: debian
          image: debian:bookworm
          command: ["bash", "-lc", "sleep infinity"]
          volumeMounts:
            - name: pgdata
              mountPath: /var/lib/postgresql
              subPath: pgdata
      volumes:
        - name: pgdata
          persistentVolumeClaim:
            claimName: pgdata-pvc
```

```sh
kubectl apply -f pg-upgrade-shell.yaml
kubectl exec -it job/pg-upgrade-shell -n app -- bash
```

### PostgreSQL バイナリを準備する

pg_upgrade には旧バージョンと新バージョンの両方のバイナリが必要です。
そのため、作業用コンテナに PostgreSQL 15 と 18 をインストールします。
インストール時に `/var/lib/postgresql` 配下へ不要なデータが作られてしまったため、本来は別ディレクトリへマウントしておくべきでした。

```sh
set -eux
apt-get update
apt-get install -y wget gnupg lsb-release ca-certificates
wget -qO - https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg
echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update
apt-get install -y postgresql-15 postgresql-18
rm -rf /var/lib/postgresql/18
```

### 作業ユーザーとロケールを整える

pg_upgrade は root では実行できないため、postgres ユーザーで作業します。
共有ボリュームの所有者が UID 999 なので、最後に 999 へ戻します。
コンテナ起動時に `runAsUser`, `runAsGroup`, `fsGroup` を 999 に設定しておけば、この作業は省略できるかもしれません。

```sh
mkdir /var/lib/postgresql18
chown -R postgresql:postgresql /var/lib/postgresql
chown -R postgresql:postgresql /var/lib/postgresql18
su postgres
export OLD_BIN=/usr/lib/postgresql/15/bin
export NEW_BIN=/usr/lib/postgresql/18/bin
export OLD_PGDATA=/var/lib/postgresql
export NEW_PGDATA=/var/lib/postgresql18
export OLDPORT=55001
export NEWPORT=55002
```

ロケールが必要になるため、en_US.UTF-8 を生成しておきます。

```sh
apt-get update
apt-get install -y locales
sed -i 's/^# *\(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen
locale-gen
update-locale LANG=en_US.UTF-8
locale -a | grep -i en_US
```

### 旧クラスタを停止する

StatefulSet のレプリカを 0 に設定して停止します。
Argo CD で自動同期している場合は、一時的に同期を無効化します。
Longhorn を利用しているので、合わせてバックアップも取得しました。
  
PostgreSQL 15 が適切に停止できていないとアップグレードできず、`The source cluster was not shut down cleanly, state reported as: "in production"` というエラーになります。
その場合は強制停止を行います。

```sh
"$OLD_BIN/pg_controldata" "$OLD_PGDATA" | grep -E 'Database cluster state|Latest checkpoint'
# in production のままなら以下で開始と停止を実行します
mkdir ./tmp
"$OLD_BIN/pg_ctl" -D "$OLD_PGDATA" \
  -o "-c port=$OLDPORT -c unix_socket_directories=./tmp -c listen_addresses=''" start
"$OLD_BIN/pg_ctl" -D "$OLD_PGDATA" stop -m fast
```

### 新クラスタを初期化してチェックする

PostgreSQL 18 ではデフォルトでチェックサムが有効になります。
旧クラスタで有効にしていなかったため、今回は無効にした状態で移行しました。
ユーザーは `POSTGRES_USER` 環境変数で指定していたユーザーを利用します。
指定しないと `database user "mainuser" is not the install user` というエラーになるので注意してください。

```sh
$NEW_BIN/initdb -D "$NEW_PGDATA" --no-data-checksums --encoding=UTF8 --locale=C.UTF-8 -U mainuser
```

チェック用のコマンドで問題がないか確認し、問題がなければ本番の移行を実行します。

```sh
export SOCKDIR="$NEW_PGDATA"

"$NEW_BIN/pg_upgrade" \
  -b "$OLD_BIN" -B "$NEW_BIN" \
  -d "$OLD_PGDATA" -D "$NEW_PGDATA" \
  -p "$OLDPORT" -P "$NEWPORT" \
  -s "$SOCKDIR" \
  -U mainuser \
  -o "-c unix_socket_directories=$SOCKDIR -c unix_socket_permissions=0700 -c listen_addresses=''" \
  -O "-c unix_socket_directories=$SOCKDIR -c unix_socket_permissions=0700 -c listen_addresses=''" \
  --check

"$NEW_BIN/pg_upgrade" \
  -b "$OLD_BIN" -B "$NEW_BIN" \
  -d "$OLD_PGDATA" -D "$NEW_PGDATA" \
  -p "$OLDPORT" -P "$NEWPORT" \
  -s "$SOCKDIR" \
  -U mainuser \
  -o "-c unix_socket_directories=$SOCKDIR -c unix_socket_permissions=0700 -c listen_addresses=''" \
  -O "-c unix_socket_directories=$SOCKDIR -c unix_socket_permissions=0700 -c listen_addresses=''" \
  --copy --jobs "$(nproc)"
```

### ディレクトリ構成を整える

移行が完了したら、ディレクトリ構成を `/var/lib/postgresql/{version}/docker/` に統一するために整理します。

```sh
mkdir /var/lib/18/docker
mv /var/lib/postgresql/* /var/lib/18/docker
mv /var/lib/18 /var/lib/postgresql/
```

### ネットワーク経由の接続を有効にする

ローカルホストからは接続できましたが、ネットワーク越しには接続できなかったため設定を調整しました。

```sh
# kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}\t{.spec.podCIDR}\n{end}' で確認
echo 'host    all    all    10.1.0.0/16    scram-sha-256' >> /var/lib/postgresql/18/docker/pg_hba.conf
cat <<'EOF' >> /var/lib/postgresql/18/docker/postgresql.conf
listen_addresses = '*'
EOF
/usr/lib/postgresql/18/bin/pg_ctl -D /var/lib/postgresql/18/docker reload
```

作業が終わったら、PostgreSQL ユーザーの所有者を元の 999 に戻します。

```sh
chown -R 999:999 /var/lib/postgresql
```

StatefulSet のマウント先も更新します。

```yaml
volumeMounts:
- name: pgdata
  # mountPath: /var/lib/postgresql/data # 変更前
  mountPath: /var/lib/postgresql
  subPath: pgdata
```

最後に StatefulSet のレプリカを 1 に戻し、PostgreSQL のバージョンを 18 に更新します。

## 最後に

想定より手順が多く、準備に時間がかかりました。
ダウンタイムを許容できる環境であれば、バックアップとリストアによる移行のほうがシンプルかもしれません。
