---
title: "型安全な AI エージェント「Pydantic AI」を試してみた ― OSS 健康診断エージェントを作る"
description: "BigQuery と Gemini を使い、Pydantic AI で OSS 健康診断エージェント（型安全）を組んだ記録です。"
createdAt: "2025/12/18"
heroIcon: "🤖"
tags: ["AI Agent", "Pydantic AI"]
---

## AI Agent について

- 世間では AI Agent 開発が盛り上がっています。
- AI Agent とは、LLM を中心に据え、外部ツールを呼び出して複雑なタスクをこなす仕組みです。
  - ユーザーの自然言語指示をもとに、思考（ツール選択・パラメータ生成）、行動（ツール呼び出し）、観察（ツール結果受け取り）を繰り返しながら最終回答を生成します。
- AI Agent 開発は自由度を上げすぎると目的の動作をしてくれないため、設計が重要といわれています。
  - [AI エージェント開発で失敗しないための 10 のデザインパターン - フレームワークに依存しない設計の共通言語を定義する](https://zenn.dev/loglass/articles/c7f4499ec8320b)
- 代表的な AI Agent フレームワークとして Pydantic AI、OpenAI Agents SDK、LangGraph があります。
- この記事ではシンプルで軽量、必要十分と評される Pydantic AI を実際に触ってみたログを残します。


## Pydantic AI とは

- Pydantic チームが作っている Python 向けの AI エージェント・フレームワークです。
- エージェントの出力を型として扱えるので、IDE 補完や型チェックが効きます。
  - 出力は Pydantic モデルで定義し、LLM からの返答がスキーマに合わなければ自動でリトライしてくれます。
  - 破綻した JSON を自前でパースする処理を書かずに済みます。
- ツール（関数）をデコレータで登録すると自動でスキーマ化され、`RunContext` 経由で依存性注入が行われます。BigQuery クライアントなどを共有するときも素直に書けます。
- 使用する LLM モデルは抽象化されており、`GoogleModel`、`OpenAIChatModel` など好みのプロバイダに差し替えるだけで動きます。
- OpenTelemetry との統合も用意されており、トレースやコストの可視化をしやすい仕組みが備わっています。


## 方針

- BigQuery データをもとに動く 「OSS 健康診断エージェント」 を構築します。
  - 利用するデータ例は PyPI のダウンロード数、GitHub のコミット数・コントリビュータ数、Stack Overflow の質問数・解決率です。
  - メンテナンスされておらず最新データが入っていないテーブルもあるため、精度悪いのは許容する方針です。
- モデルはGeminiを使い、Google AI Studio で無料発行できる API Token を利用します。


## 実際に動かす

- コードは下記です
  - https:
- ログ出力するように自前でコードを書いています

### AI Agent のコア部分

- Agent のシステムプロンプトと、Agent が自由に選択できるツールを定義します。
- Tool にコメントドキュメントで説明を書いておくと、Agent が理解してくれます。

```python
from __future__ import annotations

from typing import Optional

from pydantic_ai import Agent, RunContext
from pydantic_ai.models.google import GoogleModel

from .bq import BigQueryTools
from .models import DownloadStats, GithubStats, HealthSummary, StackOverflowStats
from .settings import AppSettings
from pydantic_ai.models.instrumented import InstrumentationSettings

SYSTEM_PROMPT = """
あなたは「OSS 健康診断エージェント」です。ユーザーの自然文から対象パッケージと評価観点
(長期運用・コミュニティ・トレンドなど) を抽出し、登録されている BigQuery ツールを使って
客観的な指標を集めます。そのデータを根拠に健康状態を判定し、HealthSummary スキーマを
満たす JSON を返してください。

必ず以下を守ること:
- 可能であれば PyPI / GitHub / Stack Overflow すべてのツールを呼び、データに基づく理由を示す。
- Pythonパッケージでなければ PyPI ツールは呼ばない。
- score は 0–100。トレンドが強く、更新が活発で、質問が解決されていれば高得点。
- level は score に基づき green >= 75, yellow >= 45, red それ以外。
- summary / reasons / analysis_steps は日本語で、非エンジニアでも読めるようにする。
- データが欠落する場合は推測せず、不足していることを明示したうえで判断する。
- ツールを1つも呼ばないと判断した場合は、analysis_steps の先頭に
  「TOOL_SKIP_REASON: <呼ばない理由>」を必ず入れて明示する。
"""


def build_agent(settings: AppSettings) -> Agent[BigQueryTools, HealthSummary]:
    model = GoogleModel(settings.model_name)

    agent = Agent(
        model=model,
        output_type=HealthSummary,
        system_prompt=SYSTEM_PROMPT,
        instrument=InstrumentationSettings(include_content=True),
    )

    @agent.tool
    def get_download_stats(ctx: RunContext[BigQueryTools], package_name: str) -> Optional[DownloadStats]:
        """PyPI の直近ダウンロード統計を取得する。"""
        return ctx.deps.fetch_download_stats(package_name)

    @agent.tool
    def get_github_stats(ctx: RunContext[BigQueryTools], package_name: str) -> Optional[GithubStats]:
        """GitHub コミットとコントリビュータ情報を取得する。"""
        return ctx.deps.fetch_github_stats(package_name)

    @agent.tool
    def get_stackoverflow_stats(ctx: RunContext[BigQueryTools], package_name: str) -> Optional[StackOverflowStats]:
        """Stack Overflow の質問数と解決率を取得する。"""
        return ctx.deps.fetch_stackoverflow_stats(package_name)

    return agent

```

### モデル部分

- Pydantic で制約付きモデルを定義でき、安全に扱えます。
- 制約に合わないレスポンスが LLM から返ってきた場合はリトライしてくれます。
  - リトライしても制約に沿わない場合はエラーが投げられます。


```python
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field


class PackageInput(BaseModel):
    package_names: list[str] = Field(default_factory=list, description="Targets the user wants evaluated")
    focus_points: list[str] = Field(default_factory=list, description="Evaluation aspects extracted from the prompt")


class DownloadStats(BaseModel):
    package_name: str
    monthly_downloads_last_12m: list[int] = Field(default_factory=list)
    avg_downloads_last_3m: int = 0
    avg_downloads_prev_3m: int = 0
    trend: Literal["up", "flat", "down"] = "flat"


class GithubStats(BaseModel):
    repo: str
    last_commit_date: Optional[datetime]
    commit_count_last_12m: int = 0
    distinct_authors_last_12m: int = 0


class StackOverflowStats(BaseModel):
    questions_last_20y: int = 0
    accepted_ratio: float = 0.0


class EvidenceBlock(BaseModel):
    pypi_download_stats: Optional[DownloadStats] = None
    github_stats: Optional[GithubStats] = None
    stackoverflow_stats: Optional[StackOverflowStats] = None


class HealthSummary(BaseModel):
    package_name: str
    score: int = Field(..., ge=0, le=100)
    level: Literal["green", "yellow", "red"]
    summary: str
    recommended_action: str
    reasons: list[str] = Field(default_factory=list)
    evidence: EvidenceBlock
    analysis_steps: list[str] = Field(default_factory=list)
```

### 実際の応答


- Fastapi について質問してみると score 60 と判定されました。
- どのツールを選択するかなどの思考部分はサーバー側で行われており、ログには出力されません。
- 今回はクエリの組み立てを LLM に任せていないので、想定どおりの挙動をしてくれています。
  - 逆に自由に組み立てさせたほうが分析の幅が広がる可能性もあると思います。


```sh
uv run python main.py "fastapi の長期運用性とコミュニティの強さを教えて"                                                                                                                                                                                                 0 - 40.39s

=== SYSTEM PROMPT ===
あなたは「OSS 健康診断エージェント」です。ユーザーの自然文から対象パッケージと評価観点
(長期運用・コミュニティ・トレンドなど) を抽出し、登録されている BigQuery ツールを使って
客観的な指標を集めます。そのデータを根拠に健康状態を判定し、HealthSummary スキーマを
満たす JSON を返してください。

必ず以下を守ること:
- 可能であれば PyPI / GitHub / Stack Overflow すべてのツールを呼び、データに基づく理由を示す。
- Pythonパッケージでなければ PyPI ツールは呼ばない。
- score は 0–100。トレンドが強く、更新が活発で、質問が解決されていれば高得点。
- level は score に基づき green >= 75, yellow >= 45, red それ以外。
- summary / reasons / analysis_steps は日本語で、非エンジニアでも読めるようにする。
- データが欠落する場合は推測せず、不足していることを明示したうえで判断する。
- ツールを1つも呼ばないと判断した場合は、analysis_steps の先頭に
  「TOOL_SKIP_REASON: <呼ばない理由>」を必ず入れて明示する。

=== USER ===
fastapi の長期運用性とコミュニティの強さを教えて
[bq] fetch_download_stats package=fastapi
[bq] running PyPI download query
[bq] SQL:
WITH monthly AS (
          SELECT
            FORMAT_DATE('%Y-%m', DATE(timestamp)) AS ym,
            COUNT(*) AS downloads
          FROM `bigquery-public-data.pypi.file_downloads`
          WHERE file.project = @package
            AND DATE(timestamp) >= DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH)
          GROUP BY ym
        )
        SELECT ym, downloads
        FROM monthly
        ORDER BY ym
[bq] resolve_repo query for package=fastapi
[bq] SQL:
WITH urls AS (
          SELECT LOWER(url) AS url
          FROM `bigquery-public-data.pypi.distribution_metadata`,
               UNNEST(project_urls) AS url
          WHERE name = @package
          LIMIT 200
        ), more AS (
          SELECT LOWER(home_page) AS url
          FROM `bigquery-public-data.pypi.distribution_metadata`
          WHERE name = @package AND home_page IS NOT NULL
          LIMIT 50
        ), combined AS (
          SELECT url FROM urls
          UNION ALL
          SELECT url FROM more
        )
        SELECT REGEXP_EXTRACT(url, r"github\.com/([\w.-]+/[\w.-]+)") AS repo
        FROM combined
        WHERE REGEXP_CONTAINS(url, r"github\.com/([\w.-]+/[\w.-]+)")
        ORDER BY LENGTH(repo)
        LIMIT 1
[bq] fetch_stackoverflow_stats package=fastapi
[bq] running StackOverflow query on bigquery-public-data.stackoverflow.posts_questions
[bq] SQL:
WITH with_tags AS (
          SELECT
            creation_date,
            title,
            body,
            IFNULL(tags, '') AS tags,
            accepted_answer_id
          FROM `bigquery-public-data.stackoverflow.posts_questions`
          WHERE DATE(creation_date) >= DATE_SUB(CURRENT_DATE(), INTERVAL 20 YEAR)
        ), exploded AS (
          SELECT
            creation_date,
            title,
            body,
            accepted_answer_id,
            tag
          FROM with_tags,
          UNNEST(
            ARRAY(
              SELECT tag FROM UNNEST(SPLIT(REGEXP_REPLACE(tags, r'[<>]', ' '), ' ')) AS tag
              WHERE tag != ''
            )
          ) AS tag
        )
        SELECT
          COUNT(*) AS questions_last_20y,
          AVG(CASE WHEN accepted_answer_id IS NULL THEN 0 ELSE 1 END) AS accepted_ratio
        FROM exploded
        WHERE (
          REGEXP_CONTAINS(LOWER(title), CONCAT(r'\b', LOWER(@package), r'\b')) OR
          REGEXP_CONTAINS(LOWER(body),  CONCAT(r'\b', LOWER(@package), r'\b')) OR
          REGEXP_CONTAINS(LOWER(tag),   CONCAT('^', LOWER(@package), '$')) OR
          REGEXP_CONTAINS(LOWER(tag),   CONCAT('^', REGEXP_REPLACE(LOWER(@package), r'[- ]', ''), '$'))
        )
[bq] resolved repo=fastapi/fastapi
[bq] running GitHub commits query for candidates=['fastapi/fastapi', 'github.com/fastapi/fastapi', 'github.com/tiangolo/fastapi', 'tiangolo/fastapi']
[bq] SQL:
WITH commits AS (
          SELECT
            TIMESTAMP_MILLIS(author.date.seconds * 1000 + CAST(author.date.nanos / 1000000 AS INT64)) AS ts,
            author.name AS author_name
          FROM `bigquery-public-data.github_repos.commits`
          WHERE EXISTS (
            SELECT 1
            FROM UNNEST(repo_name) AS rn, UNNEST(@repos) AS cand
            WHERE LOWER(rn) = cand OR LOWER(rn) = CONCAT('github.com/', cand)
          )
        )
        SELECT
          COUNT(1) AS commit_count_last_12m,
          COUNT(DISTINCT author_name) AS distinct_authors_last_12m,
          MAX(ts) AS last_commit_date
        FROM commits
        WHERE DATE(ts) >= DATE_SUB(CURRENT_DATE(), INTERVAL 5 YEAR)
[bq] download query rows=13
[bq] stackoverflow query rows=1
[bq] stackoverflow stats questions_last_20y=4084 accepted_ratio=0.3599412340842311
[bq] github commits rows=1
[bq] github stats commit_count=0 authors=0 last_commit=None

=== MODEL CONVERSATION (JSON) ===
[
  {
    "parts": [
      {
        "content": "\nあなたは「OSS 健康診断エージェント」です。ユーザーの自然文から対象パッケージと評価観点\n(長期運用・コミュニティ・トレンドなど) を抽出し、登録されている BigQuery ツールを使って\n客観的な指標を集めます。そのデータを根拠に健康状態を判定し、HealthSummary スキーマを\n満たす JSON を返してください。\n\n必ず以
下を守ること:\n- 可能であれば PyPI / GitHub / Stack Overflow すべてのツールを呼び、データに基づく理由を示す。\n- Pythonパッケージでなければ PyPI ツールは呼ばない。\n- score は 0–100。トレンドが強く、更新が活発で、質問が解決されていれば高得点。\n- level は score に基づき green >= 75, yellow >= 45, red それ以外。\n- summary /
 reasons / analysis_steps は日本語で、非エンジニアでも読めるようにする。\n- データが欠落する場合は推測せず、不足していることを明示したうえで判断する。\n- ツールを1つも呼ばないと判断した場合は、analysis_steps の先頭に\n  「TOOL_SKIP_REASON: <呼ばない理由>」を必ず入れて明示する。\n",
        "timestamp": "2025-12-16T21:59:05.903Z",
        "dynamic_ref": null,
        "part_kind": "system-prompt"
      },
      {
        "content": "fastapi の長期運用性とコミュニティの強さを教えて",
        "timestamp": "2025-12-16T21:59:05.903Z",
        "part_kind": "user-prompt"
      }
    ],
    "instructions": null,
    "kind": "request",
    "run_id": "3757a383-40a2-409c-b397-ab1e3db9ecf1",
    "metadata": null
  },
  {
    "parts": [
      {
        "tool_name": "get_download_stats",
        "args": {
          "package_name": "fastapi"
        },
        "tool_call_id": "pyd_ai_fb8274b40ef64c6d8f48b319eba683e9",
        "id": null,
        "provider_details": {
          "thought_signature": "＜省略＞"
        },
        "part_kind": "tool-call"
      },
      {
        "tool_name": "get_github_stats",
        "args": {
          "package_name": "fastapi"
        },
        "tool_call_id": "pyd_ai_eab44dae5c1e49d9883f45e71e139c18",
        "id": null,
        "provider_details": null,
        "part_kind": "tool-call"
      },
      {
        "tool_name": "get_stackoverflow_stats",
        "args": {
          "package_name": "fastapi"
        },
        "tool_call_id": "pyd_ai_2b4f463bf1884f5eb3e7696ed9174c7a",
        "id": null,
        "provider_details": null,
        "part_kind": "tool-call"
      }
    ],
    "usage": {
      "input_tokens": 1064,
      "cache_write_tokens": 0,
      "cache_read_tokens": 0,
      "output_tokens": 373,
      "input_audio_tokens": 0,
      "cache_audio_read_tokens": 0,
      "output_audio_tokens": 0,
      "details": {
        "thoughts_tokens": 313,
        "text_prompt_tokens": 1064
      }
    },
    "model_name": "gemini-2.5-flash",
    "timestamp": "2025-12-16T21:59:09.718Z",
    "kind": "response",
    "provider_name": "google-gla",
    "provider_details": {
      "finish_reason": "STOP"
    },
    "provider_response_id": "TfJBaeX1I5f91e8P6Nq2oAE",
    "finish_reason": "stop",
    "run_id": "3757a383-40a2-409c-b397-ab1e3db9ecf1",
    "metadata": null
  },
  {
    "parts": [
      {
        "tool_name": "get_download_stats",
        "content": {
          "package_name": "fastapi",
          "monthly_downloads_last_12m": [
            78612049,
            69679517,
            80540185,
            93043368,
            103251902,
            101210365,
            113583372,
            124488267,
            144475900,
            195264088,
            214110612,
            117269993
          ],
          "avg_downloads_last_3m": 175548231,
          "avg_downloads_prev_3m": 127515846,
          "trend": "up"
        },
        "tool_call_id": "pyd_ai_fb8274b40ef64c6d8f48b319eba683e9",
        "metadata": null,
        "timestamp": "2025-12-16T21:59:14.149Z",
        "part_kind": "tool-return"
      },
      {
        "tool_name": "get_github_stats",
        "content": {
          "repo": "fastapi/fastapi",
          "last_commit_date": null,
          "commit_count_last_12m": 0,
          "distinct_authors_last_12m": 0
        },
        "tool_call_id": "pyd_ai_eab44dae5c1e49d9883f45e71e139c18",
        "metadata": null,
        "timestamp": "2025-12-16T21:59:22.602Z",
        "part_kind": "tool-return"
      },
      {
        "tool_name": "get_stackoverflow_stats",
        "content": {
          "questions_last_20y": 4084,
          "accepted_ratio": 0.3599412340842311
        },
        "tool_call_id": "pyd_ai_2b4f463bf1884f5eb3e7696ed9174c7a",
        "metadata": null,
        "timestamp": "2025-12-16T21:59:19.091Z",
        "part_kind": "tool-return"
      }
    ],
    "instructions": null,
    "kind": "request",
    "run_id": "3757a383-40a2-409c-b397-ab1e3db9ecf1",
    "metadata": null
  },
  {
    "parts": [
      {
        "tool_name": "final_result",
        "args": {
          "level": "yellow",
          "score": 60,
          "evidence": {
            "pypi_download_stats": {
              "avg_downloads_last_3m": 175548231,
              "package_name": "fastapi",
              "avg_downloads_prev_3m": 127515846,
              "monthly_downloads_last_12m": [
                78612049,
                69679517,
                80540185,
                93043368,
                103251902,
                101210365,
                113583372,
                124488267,
                144475900,
                195264088,
                214110612,
                117269993
              ],
              "trend": "up"
            },
            "stackoverflow_stats": {
              "accepted_ratio": 0.3599412340842311,
              "questions_last_20y": 4084
            },
            "github_stats": {
              "commit_count_last_12m": 0,
              "distinct_authors_last_12m": 0,
              "repo": "fastapi/fastapi",
              "last_commit_date": null
            }
          },
          "summary": "FastAPIはPyPIのダウンロード数とStack Overflowでの活発な議論から、非常に高い人気と強力なコミュニティを持つプロジェクトであると評価できます。しかし、GitHubでの最近の開発活動がツールによって報告されていないため、長期的な運用性に関しては懸念があります。この点は、その人気度と矛盾しており、さらなる調査が必要
です。",
          "package_name": "fastapi",
          "recommended_action": "FastAPIの公式GitHubリポジトリ（`fastapi/fastapi`）で最新のコミット履歴や開発活動を直接確認し、本ツールのGitHubデータとの整合性を検証することを推奨します。プロジェクトが別のリポジトリに移行していないか、あるいは開発フローに何らかの変更がないかを確認してください。",
          "reasons": [
            "極めて高い人気と成長トレンド: PyPIのデータによると、fastapiの直近3ヶ月の平均ダウンロード数は約1.75億回に達し、その前の3ヶ月と比較して大幅に増加しており、「up」のトレンドを示しています。これは、非常に多くのユーザーに利用されており、その人気が継続的に高まっていることを示し、長期的な利用基盤の強さ、ひいてはコミュ
ニティの活発さを裏付けています。",
            "活発なコミュニティサポート: Stack Overflowでは、過去20年間で4,084件ものfastapiに関する質問が投稿されており、そのうち約36%が解決済みです。これは、ユーザーが活発に情報交換を行い、問題解決のためのサポートがコミュニティ内で提供されていることを示しており、コミュニティの強さを強く支持します。",
            "GitHubでの開発活動の報告不足（要確認）: GitHubの統計データでは、過去12ヶ月間のコミット数およびユニークなコントリビューター数がともに0と報告されています。また、最終コミット日も特定できませんでした。これは通常、プロジェクトの開発が停滞している兆候であり、長期的な運用性における重大なリスクとなります。ただし、PyPI
でのダウンロードトレンドの非常に強い伸びやStack Overflowでの活発なコミュニティ活動と著しく矛盾するため、このGitHubデータについてはさらなる確認が必要です。"
          ],
          "analysis_steps": [
            "`fastapi`パッケージのPyPIダウンロード統計を取得し、その利用動向とトレンドを把握しました。これにより、パッケージの普及度と人気を評価しました。",
            "`fastapi`パッケージのGitHubリポジトリに関する統計情報を取得し、コードの更新頻度と開発者の関与度を評価しました。",
            "`fastapi`に関連するStack Overflowの質問数と解決済み質問の割合を取得し、ユーザーコミュニティの活動レベルとサポート状況を評価しました。",
            "これらの客観的なデータを総合的に分析し、パッケージの長期運用性、コミュニティの強さ、および現在の健康状態を判定しました。特に、各データ間の矛盾点については、その可能性と影響を指摘しました。"
          ]
        },
        "tool_call_id": "pyd_ai_0d1247b741d342d09b03dca81e54c64e",
        "id": null,
        "provider_details": {
          "thought_signature": "＜省略＞"
        },
        "part_kind": "tool-call"
      }
    ],
    "usage": {
      "input_tokens": 1437,
      "cache_write_tokens": 0,
      "cache_read_tokens": 748,
      "output_tokens": 4816,
      "input_audio_tokens": 0,
      "cache_audio_read_tokens": 0,
      "output_audio_tokens": 0,
      "details": {
        "cached_content_tokens": 748,
        "thoughts_tokens": 3893,
        "text_prompt_tokens": 1437,
        "text_cache_tokens": 748
      }
    },
    "model_name": "gemini-2.5-flash",
    "timestamp": "2025-12-16T21:59:47.026Z",
    "kind": "response",
    "provider_name": "google-gla",
    "provider_details": {
      "finish_reason": "STOP"
    },
    "provider_response_id": "cvJBaZ3fMYShvr0P1aXziQI",
    "finish_reason": "stop",
    "run_id": "3757a383-40a2-409c-b397-ab1e3db9ecf1",
    "metadata": null
  },
  {
    "parts": [
      {
        "tool_name": "final_result",
        "content": "Final result processed.",
        "tool_call_id": "pyd_ai_0d1247b741d342d09b03dca81e54c64e",
        "metadata": null,
        "timestamp": "2025-12-16T21:59:47.026Z",
        "part_kind": "tool-return"
      }
    ],
    "instructions": null,
    "kind": "request",
    "run_id": "3757a383-40a2-409c-b397-ab1e3db9ecf1",
    "metadata": null
  }
]

=== TOOL CALL PLAN (from model) ===
get_download_stats args={'package_name': 'fastapi'}
get_github_stats args={'package_name': 'fastapi'}
get_stackoverflow_stats args={'package_name': 'fastapi'}
final_result args={'level': 'yellow', 'score': 60, 'evidence': {'pypi_download_stats': {'avg_downloads_last_3m': 175548231, 'package_name': 'fastapi', 'avg_downloads_prev_3m': 127515846, 'monthly_downloads_last_12m': [78612049, 69679517, 80540185, 93043368, 103251902, 101210365, 113583372, 124488267, 144475900, 195264088, 2
14110612, 117269993], 'trend': 'up'}, 'stackoverflow_stats': {'accepted_ratio': 0.3599412340842311, 'questions_last_20y': 4084}, 'github_stats': {'commit_count_last_12m': 0, 'distinct_authors_last_12m': 0, 'repo': 'fastapi/fastapi', 'last_commit_date': None}}, 'summary': 'FastAPIはPyPIのダウンロード数とStack Overflowでの活
発な議論から、非常に高い人気と強力なコミュニティを持つプロジェクトであると評価できます。しかし、GitHubでの最近の開発活動がツールによって報告されていないため、長期的な運用性に関しては懸念があります。この点は、その人気度と矛盾しており、さらなる調査が必要です。', 'package_name': 'fastapi', 'recommended_action': 'FastAPIの公式G
itHubリポジトリ（`fastapi/fastapi`）で最新のコミット履歴や開発活動を直接確認し、本ツールのGitHubデータとの整合性を検証することを推奨します。プロジェクトが別のリポジトリに移行していないか、あるいは開発フローに何らかの変更がないかを確認してください。', 'reasons': ['極めて高い人気と成長トレンド: PyPIのデータによると、fastapiの
直近3ヶ月の平均ダウンロード数は約1.75億回に達し、その前の3ヶ月と比較して大幅に増加しており、「up」のトレンドを示しています。これは、非常に多くのユーザーに利用されており、その人気が継続的に高まっていることを示し、長期的な利用基盤の強さ、ひいてはコミュニティの活発さを裏付けています。', '活発なコミュニティサポート: Stack Overf
lowでは、過去20年間で4,084件ものfastapiに関する質問が投稿されており、そのうち約36%が解決済みです。これは、ユーザーが活発に情報交換を行い、問題解決のためのサポートがコミュニティ内で提供されていることを示しており、コミュニティの強さを強く支持します。', 'GitHubでの開発活動の報告不足（要確認）: GitHubの統計データでは、過去12ヶ
月間のコミット数およびユニークなコントリビューター数がともに0と報告されています。また、最終コミット日も特定できませんでした。これは通常、プロジェクトの開発が停滞している兆候であり、長期的な運用性における重大なリスクとなります。ただし、PyPIでのダウンロードトレンドの非常に強い伸びやStack Overflowでの活発なコミュニティ活動と著
しく矛盾するため、このGitHubデータについてはさらなる確認が必要です。'], 'analysis_steps': ['`fastapi`パッケージのPyPIダウンロード統計を取得し、その利用動向とトレンドを把握しました。これにより、パッケージの普及度と人気を評価しました。', '`fastapi`パッケージのGitHubリポジトリに関する統計情報を取得し、コードの更新頻度と開発者
の関与度を評価しました。', '`fastapi`に関連するStack Overflowの質問数と解決済み質問の割合を取得し、ユーザーコミュニティの活動レベルとサポート状況を評価しました。', 'これらの客観的なデータを総合的に分析し、パッケージの長期運用性、コミュニティの強さ、および現在の健康状態を判定しました。特に、各データ間の矛盾点については、その
可能性と影響を指摘しました。']}
{
  "package_name": "fastapi",
  "score": 60,
  "level": "yellow",
  "summary": "FastAPIはPyPIのダウンロード数とStack Overflowでの活発な議論から、非常に高い人気と強力なコミュニティを持つプロジェクトであると評価できます。しかし、GitHubでの最近の開発活動がツールによって報告されていないため、長期的な運用性に関しては懸念があります。この点は、その人気度と矛盾しており、さらなる調査が必要です。",
  "recommended_action": "FastAPIの公式GitHubリポジトリ（`fastapi/fastapi`）で最新のコミット履歴や開発活動を直接確認し、本ツールのGitHubデータとの整合性を検証することを推奨します。プロジェクトが別のリポジトリに移行していないか、あるいは開発フローに何らかの変更がないかを確認してください。",
  "reasons": [
    "極めて高い人気と成長トレンド: PyPIのデータによると、fastapiの直近3ヶ月の平均ダウンロード数は約1.75億回に達し、その前の3ヶ月と比較して大幅に増加しており、「up」のトレンドを示しています。これは、非常に多くのユーザーに利用されており、その人気が継続的に高まっていることを示し、長期的な利用基盤の強さ、ひいてはコミュニティの
活発さを裏付けています。",
    "活発なコミュニティサポート: Stack Overflowでは、過去20年間で4,084件ものfastapiに関する質問が投稿されており、そのうち約36%が解決済みです。これは、ユーザーが活発に情報交換を行い、問題解決のためのサポートがコミュニティ内で提供されていることを示しており、コミュニティの強さを強く支持します。",
    "GitHubでの開発活動の報告不足（要確認）: GitHubの統計データでは、過去12ヶ月間のコミット数およびユニークなコントリビューター数がともに0と報告されています。また、最終コミット日も特定できませんでした。これは通常、プロジェクトの開発が停滞している兆候であり、長期的な運用性における重大なリスクとなります。ただし、PyPIでのダウ
ンロードトレンドの非常に強い伸びやStack Overflowでの活発なコミュニティ活動と著しく矛盾するため、このGitHubデータについてはさらなる確認が必要です。"
  ],
  "evidence": {
    "pypi_download_stats": {
      "package_name": "fastapi",
      "monthly_downloads_last_12m": [
        78612049,
        69679517,
        80540185,
        93043368,
        103251902,
        101210365,
        113583372,
        124488267,
        144475900,
        195264088,
        214110612,
        117269993
      ],
      "avg_downloads_last_3m": 175548231,
      "avg_downloads_prev_3m": 127515846,
      "trend": "up"
    },
    "github_stats": {
      "repo": "fastapi/fastapi",
      "last_commit_date": null,
      "commit_count_last_12m": 0,
      "distinct_authors_last_12m": 0
    },
    "stackoverflow_stats": {
      "questions_last_20y": 4084,
      "accepted_ratio": 0.3599412340842311
    }
  },
  "analysis_steps": [
    "`fastapi`パッケージのPyPIダウンロード統計を取得し、その利用動向とトレンドを把握しました。これにより、パッケージの普及度と人気を評価しました。",
    "`fastapi`パッケージのGitHubリポジトリに関する統計情報を取得し、コードの更新頻度と開発者の関与度を評価しました。",
    "`fastapi`に関連するStack Overflowの質問数と解決済み質問の割合を取得し、ユーザーコミュニティの活動レベルとサポート状況を評価しました。",
    "これらの客観的なデータを総合的に分析し、パッケージの長期運用性、コミュニティの強さ、および現在の健康状態を判定しました。特に、各データ間の矛盾点については、その可能性と影響を指摘しました。"
  ]
}

```

### ピンポイント質問の例

- 質問を「ReactのStackOverflowでの質問回答率ってどれくらい？」のように絞り込むと、そのタスクだけを実行してくれます。
- ただし、この場合もScoreを算出する挙動を維持していて、充分なデータがない状態で結果を出すことになります。


```sh
uv run python main.py "ReactのStackOverflowでの質問回答率ってどれくらい？"                                                                                                                                                                                               0 - 35.39s

=== SYSTEM PROMPT ===
あなたは「OSS 健康診断エージェント」です。ユーザーの自然文から対象パッケージと評価観点
(長期運用・コミュニティ・トレンドなど) を抽出し、登録されている BigQuery ツールを使って
客観的な指標を集めます。そのデータを根拠に健康状態を判定し、HealthSummary スキーマを
満たす JSON を返してください。

必ず以下を守ること:
- 可能であれば PyPI / GitHub / Stack Overflow すべてのツールを呼び、データに基づく理由を示す。
- Pythonパッケージでなければ PyPI ツールは呼ばない。
- score は 0–100。トレンドが強く、更新が活発で、質問が解決されていれば高得点。
- level は score に基づき green >= 75, yellow >= 45, red それ以外。
- summary / reasons / analysis_steps は日本語で、非エンジニアでも読めるようにする。
- データが欠落する場合は推測せず、不足していることを明示したうえで判断する。
- ツールを1つも呼ばないと判断した場合は、analysis_steps の先頭に
  「TOOL_SKIP_REASON: <呼ばない理由>」を必ず入れて明示する。

=== USER ===
ReactのStackOverflowでの質問回答率ってどれくらい？
[bq] fetch_stackoverflow_stats package=React
[bq] running StackOverflow query on bigquery-public-data.stackoverflow.posts_questions
[bq] SQL:
WITH with_tags AS (
          SELECT
            creation_date,
            title,
            body,
            IFNULL(tags, '') AS tags,
            accepted_answer_id
          FROM `bigquery-public-data.stackoverflow.posts_questions`
          WHERE DATE(creation_date) >= DATE_SUB(CURRENT_DATE(), INTERVAL 20 YEAR)
        ), exploded AS (
          SELECT
            creation_date,
            title,
            body,
            accepted_answer_id,
            tag
          FROM with_tags,
          UNNEST(
            ARRAY(
              SELECT tag FROM UNNEST(SPLIT(REGEXP_REPLACE(tags, r'[<>]', ' '), ' ')) AS tag
              WHERE tag != ''
            )
          ) AS tag
        )
        SELECT
          COUNT(*) AS questions_last_20y,
          AVG(CASE WHEN accepted_answer_id IS NULL THEN 0 ELSE 1 END) AS accepted_ratio
        FROM exploded
        WHERE (
          REGEXP_CONTAINS(LOWER(title), CONCAT(r'\b', LOWER(@package), r'\b')) OR
          REGEXP_CONTAINS(LOWER(body),  CONCAT(r'\b', LOWER(@package), r'\b')) OR
          REGEXP_CONTAINS(LOWER(tag),   CONCAT('^', LOWER(@package), '$')) OR
          REGEXP_CONTAINS(LOWER(tag),   CONCAT('^', REGEXP_REPLACE(LOWER(@package), r'[- ]', ''), '$'))
        )
[bq] stackoverflow query rows=1
[bq] stackoverflow stats questions_last_20y=472701 accepted_ratio=0.40760226866454713
[bq] resolve_repo query for package=React
[bq] SQL:
WITH urls AS (
          SELECT LOWER(url) AS url
          FROM `bigquery-public-data.pypi.distribution_metadata`,
               UNNEST(project_urls) AS url
          WHERE name = @package
          LIMIT 200
        ), more AS (
          SELECT LOWER(home_page) AS url
          FROM `bigquery-public-data.pypi.distribution_metadata`
          WHERE name = @package AND home_page IS NOT NULL
          LIMIT 50
        ), combined AS (
          SELECT url FROM urls
          UNION ALL
          SELECT url FROM more
        )
        SELECT REGEXP_EXTRACT(url, r"github\.com/([\w.-]+/[\w.-]+)") AS repo
        FROM combined
        WHERE REGEXP_CONTAINS(url, r"github\.com/([\w.-]+/[\w.-]+)")
        ORDER BY LENGTH(repo)
        LIMIT 1
[bq] resolve_repo returned no repo
[bq] github stats skipped: repo not resolved

=== MODEL CONVERSATION (JSON) ===
[
  {
    "parts": [
      {
        "content": "\nあなたは「OSS 健康診断エージェント」です。ユーザーの自然文から対象パッケージと評価観点\n(長期運用・コミュニティ・トレンドなど) を抽出し、登録されている BigQuery ツールを使って\n客観的な指標を集めます。そのデータを根拠に健康状態を判定し、HealthSummary スキーマを\n満たす JSON を返してください。\n\n必ず以
下を守ること:\n- 可能であれば PyPI / GitHub / Stack Overflow すべてのツールを呼び、データに基づく理由を示す。\n- Pythonパッケージでなければ PyPI ツールは呼ばない。\n- score は 0–100。トレンドが強く、更新が活発で、質問が解決されていれば高得点。\n- level は score に基づき green >= 75, yellow >= 45, red それ以外。\n- summary /
 reasons / analysis_steps は日本語で、非エンジニアでも読めるようにする。\n- データが欠落する場合は推測せず、不足していることを明示したうえで判断する。\n- ツールを1つも呼ばないと判断した場合は、analysis_steps の先頭に\n  「TOOL_SKIP_REASON: <呼ばない理由>」を必ず入れて明示する。\n",
        "timestamp": "2025-12-16T22:04:52.679Z",
        "dynamic_ref": null,
        "part_kind": "system-prompt"
      },
      {
        "content": "ReactのStackOverflowでの質問回答率ってどれくらい？",
        "timestamp": "2025-12-16T22:04:52.679Z",
        "part_kind": "user-prompt"
      }
    ],
    "instructions": null,
    "kind": "request",
    "run_id": "390ad99f-8eb2-488a-9391-490d6991c3c4",
    "metadata": null
  },
  {
    "parts": [
      {
        "tool_name": "get_stackoverflow_stats",
        "args": {
          "package_name": "React"
        },
        "tool_call_id": "pyd_ai_5c450bffd8844a54a4e99e4daf258923",
        "id": null,
        "provider_details": {
          "thought_signature": "＜省略＞"
        },
        "part_kind": "tool-call"
      }
    ],
    "usage": {
      "input_tokens": 1064,
      "cache_write_tokens": 0,
      "cache_read_tokens": 0,
      "output_tokens": 85,
      "input_audio_tokens": 0,
      "cache_audio_read_tokens": 0,
      "output_audio_tokens": 0,
      "details": {
        "thoughts_tokens": 66,
        "text_prompt_tokens": 1064
      }
    },
    "model_name": "gemini-2.5-flash",
    "timestamp": "2025-12-16T22:04:54.747Z",
    "kind": "response",
    "provider_name": "google-gla",
    "provider_details": {
      "finish_reason": "STOP"
    },
    "provider_response_id": "pvNBacDHIbCl0-kP-Irv4Qc",
    "finish_reason": "stop",
    "run_id": "390ad99f-8eb2-488a-9391-490d6991c3c4",
    "metadata": null
  },
  {
    "parts": [
      {
        "tool_name": "get_stackoverflow_stats",
        "content": {
          "questions_last_20y": 472701,
          "accepted_ratio": 0.40760226866454713
        },
        "tool_call_id": "pyd_ai_5c450bffd8844a54a4e99e4daf258923",
        "metadata": null,
        "timestamp": "2025-12-16T22:05:01.625Z",
        "part_kind": "tool-return"
      }
    ],
    "instructions": null,
    "kind": "request",
    "run_id": "390ad99f-8eb2-488a-9391-490d6991c3c4",
    "metadata": null
  },
  {
    "parts": [
      {
        "tool_name": "get_github_stats",
        "args": {
          "package_name": "React"
        },
        "tool_call_id": "pyd_ai_9608120e8b084d689952de8382b0f839",
        "id": null,
        "provider_details": {
          "thought_signature": "＜省略＞"
        },
        "part_kind": "tool-call"
      }
    ],
    "usage": {
      "input_tokens": 1137,
      "cache_write_tokens": 0,
      "cache_read_tokens": 0,
      "output_tokens": 495,
      "input_audio_tokens": 0,
      "cache_audio_read_tokens": 0,
      "output_audio_tokens": 0,
      "details": {
        "thoughts_tokens": 476,
        "text_prompt_tokens": 1137
      }
    },
    "model_name": "gemini-2.5-flash",
    "timestamp": "2025-12-16T22:05:05.023Z",
    "kind": "response",
    "provider_name": "google-gla",
    "provider_details": {
      "finish_reason": "STOP"
    },
    "provider_response_id": "sPNBabGmM9if0-kPxqLjuAY",
    "finish_reason": "stop",
    "run_id": "390ad99f-8eb2-488a-9391-490d6991c3c4",
    "metadata": null
  },
  {
    "parts": [
      {
        "tool_name": "get_github_stats",
        "content": null,
        "tool_call_id": "pyd_ai_9608120e8b084d689952de8382b0f839",
        "metadata": null,
        "timestamp": "2025-12-16T22:05:07.072Z",
        "part_kind": "tool-return"
      }
    ],
    "instructions": null,
    "kind": "request",
    "run_id": "390ad99f-8eb2-488a-9391-490d6991c3c4",
    "metadata": null
  },
  {
    "parts": [
      {
        "tool_name": "final_result",
        "args": {
          "package_name": "React",
          "evidence": {
            "github_stats": null,
            "stackoverflow_stats": {
              "accepted_ratio": 0.40760226866454713,
              "questions_last_20y": 472701
            },
            "pypi_download_stats": null
          },
          "summary": "ReactはStack Overflowで非常に大規模かつ活発なコミュニティを持っており、質問数は膨大です。質問の解決率は中程度ですが、その圧倒的な利用状況を考慮すると、堅固なサポートエコシステムがあると言えます。",
          "reasons": [
            "Stack Overflowでの質問数が過去20年間で47万件を超えており、非常に活発なコミュニティと広範な利用状況を示しています。",
            "質問の回答が解決済みとしてマークされる割合は約40.8%で、これは中程度の水準ですが、膨大な質問数の中でも一定数の問題が解決されていることは、コミュニティによるサポートが機能している証拠です。"
          ],
          "score": 75,
          "level": "green",
          "recommended_action": "Stack Overflowでの質問解決率のさらなる向上を目指し、コミュニティのベストプラクティスを共有したり、公式ドキュメントでよくある質問への回答を強化したりすることが、新規ユーザーの定着に繋がります。",
          "analysis_steps": [
            "ユーザーからの入力「ReactのStackOverflowでの質問回答率」から、パッケージ名「React」と評価観点「Stack Overflowの質問回答率」を抽出しました。",
            "default_api.get_stackoverflow_stats ツールを使用して、ReactのStack Overflowに関する統計情報を取得しました。",
            "ReactはPythonパッケージではないため、PyPIに関するツールは呼びませんでした。",
            "default_api.get_github_stats ツールを呼び出しましたが、ツールからReactに関するGitHub情報は取得できませんでした。",
            "Stack Overflowの質問数（47万件以上）は非常に多いことを確認し、その高い人気と活発なコミュニティを示していると判断しました。",
            "質問の回答が解決済みとしてマークされる割合は約40.8%で、これは中程度の水準ですが、膨大な質問数の中でも一定数の問題が解決されていることを示します。",
            "これらのデータに基づき、Reactの健康状態を評価し、スコアとレベルを決定しました。"
          ]
        },
        "tool_call_id": "pyd_ai_7fc309d79991487486b2d14b6878104a",
        "id": null,
        "provider_details": {
          "thought_signature": "＜省略＞"
        },
        "part_kind": "tool-call"
      }
    ],
    "usage": {
      "input_tokens": 1174,
      "cache_write_tokens": 0,
      "cache_read_tokens": 618,
      "output_tokens": 3153,
      "input_audio_tokens": 0,
      "cache_audio_read_tokens": 0,
      "output_audio_tokens": 0,
      "details": {
        "cached_content_tokens": 618,
        "thoughts_tokens": 2656,
        "text_prompt_tokens": 1174,
        "text_cache_tokens": 618
      }
    },
    "model_name": "gemini-2.5-flash",
    "timestamp": "2025-12-16T22:05:23.696Z",
    "kind": "response",
    "provider_name": "google-gla",
    "provider_details": {
      "finish_reason": "STOP"
    },
    "provider_response_id": "w_NBac--HcSD0-kPy_PT6Ac",
    "finish_reason": "stop",
    "run_id": "390ad99f-8eb2-488a-9391-490d6991c3c4",
    "metadata": null
  },
  {
    "parts": [
      {
        "tool_name": "final_result",
        "content": "Final result processed.",
        "tool_call_id": "pyd_ai_7fc309d79991487486b2d14b6878104a",
        "metadata": null,
        "timestamp": "2025-12-16T22:05:23.696Z",
        "part_kind": "tool-return"
      }
    ],
    "instructions": null,
    "kind": "request",
    "run_id": "390ad99f-8eb2-488a-9391-490d6991c3c4",
    "metadata": null
  }
]

=== TOOL CALL PLAN (from model) ===
get_stackoverflow_stats args={'package_name': 'React'}
get_github_stats args={'package_name': 'React'}
final_result args={'package_name': 'React', 'evidence': {'github_stats': None, 'stackoverflow_stats': {'accepted_ratio': 0.40760226866454713, 'questions_last_20y': 472701}, 'pypi_download_stats': None}, 'summary': 'ReactはStack Overflowで非常に大規模かつ活発なコミュニティを持っており、質問数は膨大です。質問の解決率は中程度
ですが、その圧倒的な利用状況を考慮すると、堅固なサポートエコシステムがあると言えます。', 'reasons': ['Stack Overflowでの質問数が過去20年間で47万件を超えており、非常に活発なコミュニティと広範な利用状況を示しています。', '質問の回答が解決済みとしてマークされる割合は約40.8%で、これは中程度の水準ですが、膨大な質問数の中でも一定
数の問題が解決されていることは、コミュニティによるサポートが機能している証拠です。'], 'score': 75, 'level': 'green', 'recommended_action': 'Stack Overflowでの質問解決率のさらなる向上を目指し、コミュニティのベストプラクティスを共有したり、公式ドキュメントでよくある質問への回答を強化したりすることが、新規ユーザーの定着に繋が
ります。', 'analysis_steps': ['ユーザーからの入力「ReactのStackOverflowでの質問回答率」から、パッケージ名「React」と評価観点「Stack Overflowの質問回答率」を抽出しました。', 'default_api.get_stackoverflow_stats ツールを使用して、ReactのStack Overflowに関する統計情報を取得しました。', 'ReactはPythonパッケージではないため、PyP
Iに関するツールは呼びませんでした。', 'default_api.get_github_stats ツールを呼び出しましたが、ツールからReactに関するGitHub情報は取得できませんでした。', 'Stack Overflowの質問数（47万件以上）は非常に多いことを確認し、その高い人気と活発なコミュニティを示していると判断しました。', '質問の回答が解決済みとしてマークされる割合は
約40.8%で、これは中程度の水準ですが、膨大な質問数の中でも一定数の問題が解決されていることを示します。', 'これらのデータに基づき、Reactの健康状態を評価し、スコアとレベルを決定しました。']}
{
  "package_name": "React",
  "score": 75,
  "level": "green",
  "summary": "ReactはStack Overflowで非常に大規模かつ活発なコミュニティを持っており、質問数は膨大です。質問の解決率は中程度ですが、その圧倒的な利用状況を考慮すると、堅固なサポートエコシステムがあると言えます。",
  "recommended_action": "Stack Overflowでの質問解決率のさらなる向上を目指し、コミュニティのベストプラクティスを共有したり、公式ドキュメントでよくある質問への回答を強化したりすることが、新規ユーザーの定着に繋がります。",
  "reasons": [
    "Stack Overflowでの質問数が過去20年間で47万件を超えており、非常に活発なコミュニティと広範な利用状況を示しています。",
    "質問の回答が解決済みとしてマークされる割合は約40.8%で、これは中程度の水準ですが、膨大な質問数の中でも一定数の問題が解決されていることは、コミュニティによるサポートが機能している証拠です。"
  ],
  "evidence": {
    "pypi_download_stats": null,
    "github_stats": null,
    "stackoverflow_stats": {
      "questions_last_20y": 472701,
      "accepted_ratio": 0.40760226866454713
    }
  },
  "analysis_steps": [
    "ユーザーからの入力「ReactのStackOverflowでの質問回答率」から、パッケージ名「React」と評価観点「Stack Overflowの質問回答率」を抽出しました。",
    "default_api.get_stackoverflow_stats ツールを使用して、ReactのStack Overflowに関する統計情報を取得しました。",
    "ReactはPythonパッケージではないため、PyPIに関するツールは呼びませんでした。",
    "default_api.get_github_stats ツールを呼び出しましたが、ツールからReactに関するGitHub情報は取得できませんでした。",
    "Stack Overflowの質問数（47万件以上）は非常に多いことを確認し、その高い人気と活発なコミュニティを示していると判断しました。",
    "質問の回答が解決済みとしてマークされる割合は約40.8%で、これは中程度の水準ですが、膨大な質問数の中でも一定数の問題が解決されていることを示します。",
    "これらのデータに基づき、Reactの健康状態を評価し、スコアとレベルを決定しました。"
  ]
}

```


## 感想

- ブログに載せていませんが、同じ質問をしても最終結果が変わる点には注意が必要だと思いました。
  - LLM の性質上、同じ質問をしても同じ回答が返らないのは当然ですが、AI Agent はツールを呼ぶ・呼ばないの揺らぎで最終結果が大きく変わる印象です。
- 簡単に作れるのは魅力ですが、結果の精度や再現性を保つのは難しそうです。
  - 今回みたいな絶対基準がないスコア算出は、ツールを呼ぶ呼ばないで結果がブレるので向かななそうです。
  - 社内QAでデータソースが複数ある場合、AI Agent にデータソース選択させるのは良さそうです。ただし、Embedding＋検索もセットで導入したほうが良い気がします。
  - あとは分析レポート（今月のプロダクト別売上を教えて、直近3ヶ月で解約率が高いプランはどれ？）を作るような明確なゴールがある場合は機能すると思います。
- 何か作用が発生するシステムでは、可能な限り LLM への依存を減らし、プログラム側でフローを制御したほうが安心だと思います。
