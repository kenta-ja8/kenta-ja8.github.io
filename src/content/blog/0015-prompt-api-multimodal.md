---
title: "Chrome Prompt API で画像・動画・音声を試した記録"
description: "Chrome 148 beta の案内をきっかけに Prompt API を試し、画像チャット・動画のリアルタイム説明・音声文字起こしを作りながら、向いている用途と詰まりどころを整理した記録です。"
createdAt: "2026/04/28"
heroIcon: "🎥"
tags: ["Chrome", "Prompt API", "Gemini Nano"]
---

## はじめに

Chrome 148 beta のリリース案内で Prompt API の話を見て、`localhost` で試してみました。
検証に使ったのは Chrome `148.0.7778.5` beta (`Official Build`, `arm64`) です。

作ったのは次の 3 画面です。

- `Chat` — テキストと画像を送る通常のチャット画面
- `Live Vision` — カメラ映像や再生中の動画を見ながら、一定間隔で内容を説明する画面
- `Audio Transcription` — 音声ファイルを文字起こしする画面

最初は「動画もそのまま送れば ChatGPT のように解析できるのでは」と思っていましたが、実際には少し違いました。
この記事では、Prompt API で何ができるのか、どこで詰まったのか、どういう使い方が自然だったのかをまとめます。



## Prompt API でできること

Prompt API は、Chrome が管理する `Gemini Nano` に対して、ブラウザから直接プロンプトを送るための API です。

扱える入力は少なくとも次のとおりです。

- `text`
- `image`
- `audio`

`image` の入力値としては `File` や `Blob` のほか、`HTMLImageElement`、`HTMLCanvasElement`、`HTMLVideoElement` なども渡せます。

ここで重要なのが、video と audio の入力モデルの違いです。
公式 docs では、`HTMLVideoElement` は「現在の video position のフレームを使う」と説明されています。
動画ファイル全体をまとめて理解するのではなく、その瞬間のフレームを視覚入力として使う前提です。

一方で `audio` は `Blob` や `ArrayBuffer` などをそのまま音声入力として渡せます。
docs 上は「現在位置だけ」を使うとは書かれていないので、音声クリップ全体を 1 つの入力として扱う前提に見えます。
ただし、長い音声は 1 回で丸ごと渡すと扱いづらかったので、実装では 10〜20 秒程度にチャンク分割した方が安定しました。

まとめると、体感としては次のような違いがありました。

- video は現在フレーム中心の入力
- audio はクリップ全体を渡す入力


## 今回の構成

この性質に合わせて、UI を次のように分けました。

### Chat

- テキストと画像を送る画面です。
- `File` をそのまま `type: "image"` で渡します。
- `responseConstraint` を使って JSON Schema 付きの structured output も試せるようにしました。

![Chat デモ 1](/blog/0015-prompt-api-multimodal/chat-1.webp)
![Chat デモ 2](/blog/0015-prompt-api-multimodal/chat-2.webp)

OCR として使ってみると、画像がはっきりしていれば読み取れますが、少しぼやけると精度が落ちる印象でした。

### Live Vision

- カメラまたは upload 動画を `<video>` に表示します。
- その `HTMLVideoElement` を一定間隔で Prompt API に渡します。
- 毎回「今見えている内容」を簡潔に説明させます。

<video src="/blog/0015-prompt-api-multimodal/live-vision-1.mp4" controls playsinline></video>

登場人物や簡単な動きを説明させる用途には十分使えそうです。

### Audio Transcription

- 音声ファイルを `type: "audio"` として渡す画面です。
- 長い音声は 1 回で投げるより、10〜20 秒程度にチャンク分割して順に文字起こしした方が安定しました。
- 今回の実装では、各チャンクの結果を途中から読めるようにして、最後まで待たなくても進捗が分かるようにしました。

<video src="/blog/0015-prompt-api-multimodal/live-vision-2.mp4" controls playsinline></video>

デモには、[高市早苗氏が内閣総理大臣に任命された際のスピーチ音声](https://commons.wikimedia.org/wiki/File:Sanae_Takaichi_delivers_remarks_after_being_appointed_Prime_Minister_of_Japan_-_21_October_2025.wav)（内閣官房 / CC BY 4.0 / 一部使用）を使用しました。

フィラー（「えー」「あの」など）は出てしまいますが、何を話しているかを把握する用途なら十分使えそうです。



## セットアップ

現時点では、Prompt API は次のいずれかの条件を満たさないと動作しません。

- `localhost` でフラグを有効化して試す
- オリジントライアルに申請し、審査を通過したドメインで trial token を使う

本番環境でそのまま使えるわけではないので、試す際は注意が必要です。

### 必要なフラグ

`localhost` で試すときは、次の 3 つのフラグを有効化します。

- `chrome://flags/#optimization-guide-on-device-model` — on-device model 実行基盤の有効化
- `chrome://flags/#prompt-api-for-gemini-nano` — Prompt API 本体の有効化
- `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` — image / audio 入力の multimodal 拡張

この 3 つは「下回りの実行基盤 → API 本体 → multimodal 拡張」という階層になっています。

なお、web 向け Prompt API はオリジントライアルとして提供されており、
登録した origin に trial token をページに載せると実際のユーザー向けに試せます。

利用前には `availability()` で動作確認もしました。
画面ごとに `expectedInputs` が変わるので、Chat / Live Vision なら `image`、Audio Transcription なら `audio` を渡す型として指定する必要があります。

### 初回ダウンロード

Prompt API 自体は Chrome に含まれていますが、Gemini Nano のモデルは最初の利用時に別途ダウンロードされます。
回線速度や端末性能によって時間は変わります。自分の環境では次のような感じでした。

- モデルサイズ（`chrome://on-device-internals` で確認）: `4072MB`
- 初回ダウンロード完了まで: `1 分以上`

進捗を見たい場合は `create()` の `monitor` で `downloadprogress` イベントを受け取れます。

### モデル管理

Chrome はモデルの配布・更新・削除まで自動管理しています。知っておくと挙動が把握しやすいです。

- モデルは `*.create()` の初回呼び出しでオンデマンドにダウンロードされます。
- Chrome が GPU 性能などを見て、モデルのサイズや推論方式（CPU / GPU）を判断します。
- ハードウェア要件を満たさない端末ではモデルはダウンロードされません。
- ブラウザ起動時に更新確認し、新しいモデルをバックグラウンドでダウンロードしてホットスワップします。
- ディスク空き容量がしきい値を下回ると自動削除され、次の `*.create()` 呼び出しで再ダウンロードされます。

### ダウンロード中のハイブリッド実装

初回ダウンロードが完了するまでの間、ローカルモデルが使えません。
Chrome の公式 docs では、この待ち時間をクラウド API（Gemini API など）でカバーし、
ダウンロード完了後にローカルセッションへ切り替えるハイブリッド構成が案内されています。

実装の流れは次のとおりです。

1. `availability()` でローカルモデルの状態を確認する
2. ダウンロード中であればクラウド API にリクエストを送る
3. `create()` の `monitor` でダウンロード完了を検知する
4. 完了後、以降のリクエストをローカルセッションに切り替える

品質のブレを抑えるため、クラウド側も同じモデルファミリー（Gemini）を使うことが推奨されています。


## 詰まったところ

### `Error code: 5` — Chat から `HTMLVideoElement` を送ろうとした

Chat 側でも `HTMLVideoElement` を送りたかったのですが、`Error code: 5` が出たりタブごと落ちたりしました。
そもそも `HTMLVideoElement` を image 型で渡したとき、API が見るのは動画全体ではなくその時点のフレームだけです。
1 回の送信で動画全体を理解させることはできないため、Chat との相性が悪く、最終的に動画は `Live Vision` に寄せました。


## まとめ

一度モデルを落とせば追加の利用料金もなく、画像説明・視覚付きチャット・音声文字起こしをブラウザだけで試せます。

ダウンロード中はクラウド API にフォールバックし、完了後はローカルへ自動切り替えするハイブリッド構成も公式が案内しており、UX 観点でも優れていると感じました。
ユーザーは「モデルがまだ手元にない」ことを意識せずに使い始められ、バックグラウンドで準備が整ったらそのままローカル推論に移行します。
クラウド側も同じ Gemini ファミリーを使うことで品質のブレも抑えられるため、移行タイミングをユーザーに知らせる必要すらありません。

動画については「今見えているものをローカルで説明する」用途に割り切ると一気に扱いやすくなりました。
音声も、長いファイルを分割して処理すればローカル文字起こしの感触を十分試せました。

動かしてみて率直に感じたのは「ローカルリソースをそこまでハードに使っているわけでもないのに、これだけ動くのか」という驚きでした。
GPU をフル回転させているわけでもなく、ブラウザのタブの一つとして普通に動いています。
4GB 超のモデルを一度落とせば、あとはネットも API キーも不要でマルチモーダルな推論が走る、というのは体験として新鮮でした。

今後どういう使われ方をするのか考えると、プライバシーを手放したくない処理（医療・法律・社内文書など）や、オフライン環境での AI 支援は自然なユースケースに見えます。
ただ最も可能性を感じるのはリアルタイム処理の領域で、今回の Live Vision のようにカメラ映像を逐次解析する用途はクラウドだとラウンドトリップのコストが重くのしかかります。
ローカルで推論できる強みがいちばん活きるのはこの領域だと思うので、モデルの精度が上がるにつれて、リアルタイム系のユースケースを中心に面白い使われ方が増えてくるのではないかと期待しています。


## リポジトリ

- [kenta-ja8/chrome-prompt](https://github.com/kenta-ja8/chrome-prompt)

## 参考

- [The Prompt API | Chrome for Developers](https://developer.chrome.com/docs/ai/prompt-api)
- [Get started with built-in AI | Chrome for Developers](https://developer.chrome.com/docs/ai/get-started)
- [Understand built-in model management in Chrome | Chrome for Developers](https://developer.chrome.com/docs/ai/understand-built-in-model-management)
- [Inform users of model download | Chrome for Developers](https://developer.chrome.com/docs/ai/inform-users-of-model-download)
- [Chrome 148 beta | Chrome for Developers](https://developer.chrome.com/blog/chrome-148-beta)
- [AI APIs are in stable and origin trials, with new Early Preview Program APIs | Chrome for Developers](https://developer.chrome.com/blog/ai-api-updates-io25)
- [Debug Gemini Nano | Chrome for Developers](https://developer.chrome.com/docs/ai/debug-gemini-nano)
