---
title: "GoでProto.Actorを試しながらActorモデルを整理する"
description: "Proto.Actor for Go を触りながら、アクターモデルの基本概念とクラスタ構成の勘所をまとめたノート"
createdAt: "2025/10/02"
heroIcon: "🤖"
tags: ["Go", "Actor", "Proto.Actor"]
---

## Actorモデルについて

- Actorモデルは、計算をアクターという独立した主体に分割し、メッセージ送受信で協調させることでロック共有を避けつつ並行処理とスケールアウトを実現するアプローチです。
- Go界隈では「goroutine + channel で十分」という声もある一方で、Ergo、Goakt、Hollywood、Proto.Actor など、アクター指向のフレームワークも整備されています。
- 本稿では Proto.Actor を題材に、基本概念とチュートリアルを試した際のメモを残します。

## 用語

### Actor
Actor は状態 (state) と振る舞い (behavior) を併せ持つ最小単位のコンポーネントです。メッセージを受信すると、現在の状態と振る舞いに基づいて状態を更新したり、別の Actor へメッセージを送ったり、新しい Actor を生成したりします。

### Behavior
Actor が次に受け取るメッセージにどのように応答するかを定義する関数。

### Supervisor
Actor のライフサイクルを管理する上位の Actor。障害が発生した子 Actor を再起動・停止するなどの戦略を適用し、システム全体の自己回復性を高めます。

### Mailbox
Actor が受け取ったメッセージを保持するキュー。Proto.Actor ではデフォルトでメモリ内キューが使われるため、必要に応じて永続化やバックプレッシャーを組み合わせます。

### Message
Actor 間でやり取りされるデータ。

### PID (Process ID)
Actor を一意に識別する参照。場所透過性を備えており、PID が分かればノード位置を意識せずメッセージを送れます。

## [Getting Started](https://proto.actor/docs/cluster/getting-started-go/) を動かしたメモ

- main/Actor(smartbulb) を手動作成し、自動生成でprotoファイルからクライアントコードを生成、状態変更を確認する流れです。
- 少し改変して、現在のStateと変更後のStateを表示するようにしました。

### ソース
- https://github.com/kenta-ja8/protoactor-go-pg/tree/main/getting-started-go

```go:main.go
package main

import (
	"fmt"
	"time"

	"protoactor-go-pg/getting-started-go/smartbulb"

	"github.com/asynkron/protoactor-go/actor"
	"github.com/asynkron/protoactor-go/cluster"
	"github.com/asynkron/protoactor-go/cluster/clusterproviders/consul"
	"github.com/asynkron/protoactor-go/cluster/identitylookup/disthash"
	"github.com/asynkron/protoactor-go/remote"
)

func main() {
	system := actor.NewActorSystem()

	provider, _ := consul.New()
	lookup := disthash.New()
	remoteConfig := remote.Configure("localhost", 0)

	bulbKind := smartbulb.NewSmartBulbKind(func() smartbulb.SmartBulb { return &smartbulb.Bulb{} }, 30*time.Second,)
	clusterConfig := cluster.Configure("ProtoClusterTutorial", provider, lookup, remoteConfig, cluster.WithKinds(bulbKind))
	c := cluster.New(system, clusterConfig)

	c.StartMember()
	fmt.Println("Cluster member started.")

	bulbClient := smartbulb.GetSmartBulbGrainClient(c, "kitchen")
	state, _ := bulbClient.GetState(nil)
	fmt.Println("current:", state.IsOn)

	if _, err := bulbClient.TurnOn(nil); err != nil {
		panic(err)
	}
	state, _ = bulbClient.GetState(nil)
	fmt.Println("next:", state.IsOn)

	fmt.Println("Press Enter to exit...")
	fmt.Scanln()
	c.Shutdown(true)
}
```

```bash
go get -tool google.golang.org/protobuf/cmd/protoc-gen-go@latest
go get -tool google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
go get -tool github.com/asynkron/protoactor-go/protobuf/protoc-gen-go-grain@latest

protoc -I . \
  --plugin=protoc-gen-go=$(go tool -n protoc-gen-go) \
  --plugin=protoc-gen-go-grpc=$(go tool -n protoc-gen-go-grpc) \
  --plugin=protoc-gen-go-grain=$(go tool -n protoc-gen-go-grain) \
  --go_out=.          --go_opt=paths=source_relative \
  --go-grpc_out=.     --go-grpc_opt=paths=source_relative \
  --go-grain_out=.    --go-grain_opt=paths=source_relative \
  getting-started-go/smartbulb.proto

consul agent -dev
go run getting-started-go/main.go
go run getting-started-go/main.go
```

### Getting Started を実行したメモ

- `remote.Configure("localhost", 0)` で gRPC リスナーをローカルホストにバインドします。
- `consul.New()` がハートビートを送りつつ、ポーリングで他メンバーの死活監視をします。
- `lookup := disthash.New()` で特定IDの仮想アクターをどのメンバーで動かすか／どこにいるかを解決
- Consul の代わりに Kubernetes プロバイダへ差し替えれば、Kubernetes API 経由でメンバー管理とサービスディスカバリを行えます。
- `consul agent -dev` を実行すると、開発用のシングルノード Consul Agent が `http://127.0.0.1:8500` で起動します。
- Consul は HashiCorp が提供するサービスネットワーキング基盤で、サービスディスカバリ、ヘルスチェック、Service Mesh (mTLS/意図ベース許可)、L7 トラフィック制御、KV ストアを提供します。
- `smartbulb.NewSmartBulbKind(func() smartbulb.SmartBulb { return &smartbulb.Bulb{} }, 30*time.Second)` では、30 秒間メッセージが来なければインスタンスを回収する idle timeout を設定しています。
- `smartbulb.GetSmartBulbGrainClient(c, "kitchen")` のように ID を指定すると、その ID で一意の Actor が生成されます。
- Actor が別プロセス／別ノードで動作する場合は gRPC 経由でメッセージ配送され、同一プロセス内であればメモリ内配送になります。
- クラスタノード間では双方向の gRPC ストリームを張り、P2P でメッセージを交換します。
- Protobuf を定義し、自動生成でGoコードを生成、手動でprotobufで定義したrpcと同名のメソッドを実装します

## コンセプト

- [ドキュメント](https://proto.actor/docs/)にコンセプトが書いてあります。

### コンセプトを読んだメモ

- Mailbox はメモリ内キューのため、耐障害性が必要なら永続化やバッファ制限を検討します。
- `.Watch` で Actor の停止を監視でき、リカバリ処理に使えます。
- `PoisonPill` は新規メッセージの受付を止め、既存の処理完了後に Actor を停止します。`Stop` は直ちに停止させる点が異なります。
- `Touch` で PID が生存しているかを確認できます。
- メッセージ送信 API
  - `Send`: 応答を待たないワンウェイメッセージです。
  - `Request`: 応答を待つ同期リクエストです。
  - `RequestFuture`: Future を受け取り、タイムアウト付きで応答を待ちます。
- Proto.Actor の基本配送保証は at-most-onceです。必要なら ACK/Retry や冪等にする仕組みをアプリ側で実装します。
- 送信者 x 受信者の組み合わせ内ではメッセージ順序が保持されます。
- 高い信頼性を求める場合のパターン
  - ACK / RETRY: message ID を付与し、ACK が来なければ再送します。受信側で重複排除して冪等性を保ちます。
  - イベントソーシング: コマンドから生成したイベントを永続化し、スナップショットとリプレイで状態を復元します。
- 比較
  - Actor は、並行処理に強くマイクロ秒級だが、メッセージの配達保証や順序保証は基本的に提供してません。IoTやゲームに向いてます。
  - Queeue（RabbitMQ）やLog（Kafka）は、配達保証（at-least-once など）や順序/再処理ができるがミリ秒級です。
- サービスディスカバリの実装手段には DNS、中央レジストリ (Consul / etcd / Kubernetes API)、Gossip (ノード間でメンバー情報を直接交換) があります。
- シャーディングにより、仮想アクターをクラスタ全体に分散配置して、単一ノードがボトルネックにならないようにできます
  - キーを基に、そのIDのアクターがどのノードで動いているかを解決してメーセージを送ります
  - トポロジ変化でアクターの再配置が起きます
  - ID、Actorの組み合わせで一意に決まるが、再配置のタイミングで一時的に複数ノードに同じIDのActorが存在する可能性があります

