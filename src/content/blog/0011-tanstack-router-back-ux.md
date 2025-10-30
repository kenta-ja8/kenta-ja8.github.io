---
title: "TanStack Routerで戻る体験を向上させる"
description: "戻るリンクやパンくずリストからスクロール位置とクエリを自然に復元するための設計プロセスと実装手順をまとめました。"
createdAt: "2025/10/31"
heroIcon: "🔙"
tags: ["React", "TanStack Router", "UX"]
---


## はじめに

TanStack Routerで一覧ページと詳細ページを行き来する際に、戻るリンクやパンくずリストから戻ったときの体験を向上させたいと考えました。
ブラウザの戻る・進むボタンを使う場合はTanStack Routerの標準機能で十分ですが、画面内に配置した戻るリンクではクエリパラメーターやスクロール位置が失われがちです。
本記事では、それらを自然に復元するために行った検討内容と実装方法をまとめます。

## 想定しているユースケース

例えば、一覧から詳細ページに移動して戻るリンクを押したときに、ユーザーは「さっき見ていた位置に戻る」と期待します。
ところが、以下のような問題が起きると体験が損なわれます。
- クエリパラメーターが初期化されて絞り込みやソート条件が失われてしまう
- スクロール位置がページトップに戻り、再び同じ場所までスクロールする必要が生じる

これらを踏まえ、次の要件を満たすことを目指しました。
- 過去に表示した同一パスへ戻る際にスクロール位置を復元する
- 開発者が個別に状態を引き回さなくてもクエリパラメーターを復元する
- 履歴が見つからない場合は安全なフォールバック先に遷移する
- グローバルメニューからの遷移は新しいフローとして扱い、復元処理をしない

## MPAでのスクロール復元

マルチページアプリケーション（MPA）では、BFCache（Back/Forward Cache）がスクロール位置を含むページ状態を復元することが多いです。
BFCacheはページ全体のスナップショットをメモリに保持し、戻る操作時に瞬時に復元します。
ただし、`fetch` や `WebSocket` が開いている場合、`window.opener` を参照している場合などでは無効化されます。
  
BFCacheが機能しない場合に備えて`history.scrollRestoration`も用意されています。
既定値は`auto`で、ブラウザが読み込み直し後にスクロール位置を復元しようとします。
しかし、非同期でコンテンツが描画されるページでは復元時点で高さが足りず、期待した位置までスクロールされないことがあります。
  
参考リンク
- [History: scrollRestoration プロパティ](https://developer.mozilla.org/ja/docs/Web/API/History/scrollRestoration)
- [7.4.1 Session history](https://html.spec.whatwg.org/multipage/browsing-the-web.html#session-history-infrastructure)
- [バックフォワード キャッシュ](https://web.dev/articles/bfcache?hl=ja)
- [バックフォワード キャッシュは、Yahoo!ニュースのモバイル収益が 9% 増加](https://web.dev/case-studies/yahoo-japan-news-bfcache?hl=ja)
- [ブラウザバック時の表示を最適化する Yahoo!ニュースの取り組み事例](https://techblog.yahoo.co.jp/entry/2022010530253635/)
- [ブラウザの戻る/進むを高速に！ヤフーにおけるBFCache有効化に向けた取り組み](https://techblog.yahoo.co.jp/entry/2023072430429932/)
  
Single Page Application（SPA）であるTanStack Routerではページ遷移がソフトナビゲーションのため、BFCacheの恩恵は受けません。
その代わり、`scrollRestoration = manual`にしてフレームワーク側で復元処理ができるようになっています。

## TanStack Routerのスクロール復元機能

TanStack Routerでは`createRouter`の設定で`scrollRestoration: true`を指定すると、ブラウザの戻る・進む操作に対するスクロール復元が有効になります。
ドキュメントの[Scroll Restoration](https://tanstack.com/router/v1/docs/framework/react/guide/scroll-restoration#scroll-restoration)の項で確認できます。

```ts
import { createRouter } from '@tanstack/react-router'

const router = createRouter({
  scrollRestoration: true,
})
```

任意のナビゲーションでも復元したい場合は、`getScrollRestorationKey`で保存・復元に使うキーを決められます。
例えばパス単位で復元したいときは次のように設定します。

```ts
import { createRouter } from '@tanstack/react-router'

const router = createRouter({
  scrollRestoration: true,
  getScrollRestorationKey: (location) => location.pathname,
})
```

`getScrollRestorationKey`のデフォルト実装では`__TSR_key`が利用され、各履歴エントリに一意のキーが割り当てられます。
このあたりの処理は[scroll-restoration.ts](https://github.com/TanStack/router/blob/88b6a8ca5acf8b805e9b54384557f2d1cfeb07f9/packages/router-core/src/scroll-restoration.ts#L88)に実装されています。
このキーは`history`パッケージ側で`assignKeyAndIndex`が呼ばれる際に生成されます（[history/index.ts](https://github.com/TanStack/router/blob/88b6a8ca5acf8b805e9b54384557f2d1cfeb07f9/packages/history/src/index.ts#L488)）。
  
スクロール位置は次のような形でセッションストレージに保存され、ページリロード後でも復元できます。

```ts
const cache = {
  scrollRestorationKeyXXX: {
    elementYYY: {
      scrollX: 0,
      scrollY: 0,
    },
  },
}
```

復元は`onRendered`イベントで行われ、以下の優先順位でスクロール先が決まります。
1. 保存済みのスクロール位置があればそこまでスクロールする
2. URLにハッシュがあれば対象要素までスクロールする
3. どちらもなければページトップにスクロールする
  
このあたりの処理は[scroll-restoration.ts#L106-L210](https://github.com/TanStack/router/blob/88b6a8ca5acf8b805e9b54384557f2d1cfeb07f9/packages/router-core/src/scroll-restoration.ts#L106-L210)にまとまっています。

## 実装方針

ポイントは「戻り先の履歴が持つ`__TSR_key`とクエリパラメーターを保管し、戻るリンクでそれらを引き継ぐ」ことです。
`getScrollRestorationKey`で過去のキーを返すようにし、履歴がないときはフォールバック先へ遷移させます。

### 初期化設定

リンク遷移時に過去の`__TSR_key`が渡されていれば優先的に使用します。
なければ通常のキーで復元します。

```ts
import { createRouter } from '@tanstack/react-router'

const router = createRouter({
  scrollRestoration: true,
  getScrollRestorationKey: (location) => {
    return location.state.scrollRestorationTsrKey ?? location.state.__TSR_key ?? ''
  },
})
```

### 履歴保存プロバイダー

ページ遷移のたびに現在のURLと`__TSR_key`を保存します。
アプリのルートに設置し、履歴情報をContext経由で配布します。

```ts:NavigationHistoryProvider.tsx
import { useLocation } from '@tanstack/react-router'
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { NavigationHistoryContext, NavigationHistoryContextValue } from '~/provider/navigationHistoryContext'

export const NavigationHistoryProvider = ({ children }: { children: ReactNode }) => {
  const location = useLocation()
  const [entries, setEntries] = useState<NavigationHistoryContextValue['entries']>({})

  const lastHref = useRef('')
  useEffect(() => {
    if (location.href === lastHref.current) {
      return
    }

    setEntries((prev) => {
      const path = location.href.split('?')[0]
      const nextEntry = {
        href: location.href,
        scrollRestorationTsrKey: location.state.scrollRestorationTsrKey ?? location.state.__TSR_key ?? '',
      }
      return {
        ...prev,
        [path]: nextEntry,
      }
    })

    lastHref.current = location.href
  }, [location])

  const contextValue = useMemo(() => ({ entries }), [entries])

  return <NavigationHistoryContext.Provider value={contextValue}>{children}</NavigationHistoryContext.Provider>
}
```

### Contextとフック

フォールバック先を受け取り、同じパスの履歴があればそれを戻り先として返します。
履歴がなければフォールバック先をそのまま利用します。

```ts:NavigationHistoryContext.tsx
import { HistoryState, ParsedLocation } from '@tanstack/react-router'
import React from 'react'

export type NavigationHistoryEntry = {
  href: string
  scrollRestorationTsrKey: string
}

type NavigationPath = string

export type NavigationHistoryContextValue = {
  entries: Record<NavigationPath, NavigationHistoryEntry>
}

export type BackLinkProps = {
  to: string
  state?: HistoryState
}

export const NavigationHistoryContext = React.createContext<NavigationHistoryContextValue>({
  entries: {},
})

export const useNavigationHistoryContext = (): NavigationHistoryContextValue => {
  return React.useContext<NavigationHistoryContextValue>(NavigationHistoryContext)
}

export const useBackLinkProps = (fallbackLocation: ParsedLocation): BackLinkProps => {
  const { entries } = useNavigationHistoryContext()

  const fallbackPath = fallbackLocation.href.split('?')[0]
  const matchedEntry = entries[fallbackPath]
  if (matchedEntry) {
    return {
      to: matchedEntry.href,
      state: {
        scrollRestorationTsrKey: matchedEntry.scrollRestorationTsrKey,
      },
    }
  }

  return {
    to: fallbackLocation.href,
  }
}
```

### 各ページからの利用例

開発者はフックから取得した戻り先情報を`Link`にそのまま渡すだけです。

```ts:routes/list/detail.tsx
import { Link } from '@tanstack/react-router'
import { useBackLinkProps } from '~/provider/navigationHistoryContext'
import { router } from '~/router'

function PageDetail() {
  const fallbackLocation = router.buildLocation({
    to: '/list',
    search: { xxx: 'xxx' },
  })
  const backLinkProps = useBackLinkProps(fallbackLocation)

  return <Link {...backLinkProps}>戻る</Link>
}
```

## おわりに

この仕組みによって、戻るリンクでも一覧ページのクエリパラメーターとスクロール位置を違和感なく復元できるようになりました。
TanStack Router自体はスクロール位置をセッションストレージに保存しているため、今回の履歴管理も同じくセッションストレージに保存しておくとさらに体験が良くなりそうです。
TanStack Routerのソースコードが、ReactでなくTypeScript知識でも理解しやすい構成になっていて意外でした。
