# PubMed MCP Server (Cloudflare Workers + Google OAuth)

PubMed/PMC の論文データにアクセスできるリモート MCP サーバーです。
Cloudflare Workers（無料プラン）で動作し、Google OAuth 2.1 で認証を行います。

## 機能一覧

- **10個の MCP ツール**: search, fetch, fetch_batch, get_full_text, count, find_similar_articles, export_to_ris, get_citation_counts, convert_ids, batch_process
- **Google OAuth 2.1**: Google アカウントによるセキュアな認証
- **Cloudflare Workers**: サーバーレスで無料デプロイ
- **Streamable HTTP**: 最新の MCP トランスポート
- **MeSH サポート**: 医学件名標目を使った高度な検索
- **引用数取得**: NIH iCite API 連携
- **RIS エクスポート**: EndNote / Zotero / Mendeley 用

---

## 初期セットアップ（ゼロからの手順）

### 用語解説

| 用語 | 意味 |
|------|------|
| **Cloudflare Workers** | Cloudflare が提供するサーバーレス実行環境。自分でサーバーを用意せずにコードを動かせる |
| **Wrangler** | Cloudflare Workers 用の CLI ツール。ターミナルからデプロイや設定を行う |
| **KV** | Cloudflare が提供するキーバリューストア。OAuth トークンの一時保存に使う |
| **OAuth 2.1** | ユーザー認証の業界標準。「Google でログイン」を実現する仕組み |
| **Secret** | API キーやパスワードなど、コードに書かずに安全に保管する秘密情報 |
| **リダイレクト URI** | Google ログイン後にユーザーを戻す先の URL。Google に事前登録が必要 |
| **MCP Inspector** | MCP サーバーの動作をブラウザで確認できるデバッグツール |

---

### Step 1: 前提条件

- **Node.js 18 以上**: https://nodejs.org/ からインストール
- **Cloudflare アカウント（無料）**: https://dash.cloudflare.com/sign-up で作成（クレジットカード不要）

```bash
# バージョン確認
node --version    # v18.x.x 以上
npm --version
```

---

### Step 2: リポジトリのクローンと依存関係インストール

```bash
git clone https://github.com/masa-med-ai/pubmed-mcp-remote.git
cd pubmed-mcp-remote
npm install
```

---

### Step 3: Cloudflare にログイン

```bash
npx wrangler login
```

ブラウザが開き「Allow Wrangler to access your Cloudflare account?」と表示されるので **Allow** をクリック。
ターミナルに `Successfully logged in.` と出れば成功です。

---

### Step 4: KV 名前空間の作成

OAuth トークンを一時保存するためのストレージを作成します。

```bash
npx wrangler kv namespace create OAUTH_KV
```

以下のような出力が表示されます：

```
🌀 Creating namespace with title "pubmed-mcp-OAUTH_KV"
✨ Success!
Add the following to your wrangler configuration:
  { binding = "OAUTH_KV", id = "abcdef1234567890abcdef1234567890" }
```

**`id` の値をコピー**して、`wrangler.jsonc` を編集します：

```jsonc
// wrangler.jsonc の該当箇所を更新
"kv_namespaces": [
  {
    "binding": "OAUTH_KV",
    "id": "abcdef1234567890abcdef1234567890"  // ← ここにコピーした値を貼る
  }
]
```

> **注意**: KV バインディングは **1つだけ** にしてください。同じ `"binding": "OAUTH_KV"` が2つあるとエラーになります。

---

### Step 5: Google OAuth の設定

#### 5-1. Google Cloud Console にアクセス

1. https://console.cloud.google.com/ にアクセス
2. Google アカウントでログイン

#### 5-2. プロジェクトを作成

1. 画面上部の **プロジェクト選択** をクリック
2. **「新しいプロジェクト」** → プロジェクト名（例: `PubMed MCP Server`）を入力 → **「作成」**

#### 5-3. OAuth 同意画面の設定

1. 左メニューから **「API とサービス」→「OAuth 同意画面」** を選択
2. **「開始」** をクリック
3. 以下を入力：
   - **アプリ名**: `PubMed MCP Server`
   - **ユーザーサポートメール**: 自分のメールアドレス
   - **対象**: 外部
   - **デベロッパーの連絡先メール**: 自分のメールアドレス
4. **「作成」** をクリック

> **テストモードについて**: 初期状態では自分と登録したテストユーザーのみログイン可能です。他の人にも使ってもらうには「本番環境に公開」が必要ですが、まずはテストで進めましょう。

#### 5-4. OAuth クライアント ID の作成

1. 左メニューの **「API とサービス」→「認証情報」** を選択
2. **「＋認証情報を作成」→「OAuth クライアント ID」** をクリック
3. 以下を入力：
   - **アプリケーションの種類**: ウェブ アプリケーション
   - **名前**: `PubMed MCP`（何でも OK）
   - **承認済みのリダイレクト URI**: 一旦空のまま作成（Step 8 で追加）
4. **「作成」** をクリック

表示された **クライアント ID** と **クライアント シークレット** を安全な場所にコピーしてください：

```
クライアント ID:         123456789-xxxxxxxxx.apps.googleusercontent.com
クライアント シークレット: GOCSPX-xxxxxxxxxxxxxxxxxxxx
```

---

### Step 6: Secrets の設定

Secret は Cloudflare に暗号化して保存される秘密情報です。コードやファイルには書きません。
各コマンドを実行すると入力プロンプトが出るので、値をペーストして Enter を押します。

```bash
# Google OAuth クライアント ID
npx wrangler secret put GOOGLE_CLIENT_ID
# → プロンプトに 123456789-xxxxxxxxx.apps.googleusercontent.com をペースト

# Google OAuth クライアント シークレット
npx wrangler secret put GOOGLE_CLIENT_SECRET
# → プロンプトに GOCSPX-xxxxxxxxxxxxxxxxxxxx をペースト

# Cookie 暗号化キー（ランダム生成）
# まず別のターミナルで以下を実行して出力をコピー：
#   openssl rand -hex 32
# 次に以下を実行してコピーした値をペースト：
npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

#### （任意）NCBI API キー

設定すると PubMed API のレートリミットが 3回/秒 → 10回/秒 に向上します。

1. https://www.ncbi.nlm.nih.gov/account/settings/ にアクセス
2. NCBI アカウントでログイン（なければ作成）
3. API Key を作成してコピー

```bash
npx wrangler secret put NCBI_API_KEY
```

---

### Step 7: デプロイ

```bash
npm run deploy
```

成功すると以下のように表示されます：

```
Deployed pubmed-mcp triggers (x.xx sec)
  https://pubmed-mcp.<your-subdomain>.workers.dev
```

**この URL をメモしてください。**

---

### Step 8: Google Cloud にリダイレクト URI を登録

1. Google Cloud Console → **「API とサービス」→「認証情報」** に戻る
2. Step 5-4 で作成した OAuth クライアント ID をクリック
3. **「承認済みのリダイレクト URI」** で **「＋ URI を追加」** をクリック
4. 以下を入力（**末尾の `/callback` を忘れずに**）：
   ```
   https://pubmed-mcp.<your-subdomain>.workers.dev/callback
   ```
5. **「保存」** をクリック

> **重要**: URL は 1 文字でも違うと認証が失敗します。Step 7 で表示された URL をそのままコピーして末尾に `/callback` を付けてください。

---

### Step 9: 動作確認

#### ブラウザで確認

以下にアクセスして JSON が表示されればサーバーは動作しています：

```
https://pubmed-mcp.<your-subdomain>.workers.dev/
```

#### MCP Inspector でテスト

```bash
npx @modelcontextprotocol/inspector
```

1. ブラウザが開く（開かない場合は表示された URL にアクセス）
2. **Transport Type**: `Streamable HTTP` を選択
3. **URL**: `https://pubmed-mcp.<your-subdomain>.workers.dev/mcp`
4. **Connect** をクリック
5. Google 認証画面でログイン
6. 接続成功後、左側に 8 つのツールが表示される
7. `search` を選択 → query に `COVID-19 AND vaccine` → 実行

---

## AI サービスでの利用

### Claude Desktop

`claude_desktop_config.json` に追加：

```json
{
  "mcpServers": {
    "pubmed": {
      "url": "https://pubmed-mcp.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

### Claude.ai（Web版）

1. 設定 → **カスタムコネクタを追加**
2. URL: `https://pubmed-mcp.<your-subdomain>.workers.dev/mcp`
3. 初回接続時に Google 認証が求められます

### ChatGPT

1. 設定 → **カスタムコネクタ**
2. URL: `https://pubmed-mcp.<your-subdomain>.workers.dev/mcp`

---

## ローカル開発

```bash
npm run dev
```

`http://localhost:8787` でローカルサーバーが起動します。
OAuth をローカルでテストするには、Google Cloud Console で `http://localhost:8787/callback` もリダイレクト URI に追加してください。

```bash
npx @modelcontextprotocol/inspector
# URL: http://localhost:8787/mcp
```

---

## MCP ツール一覧

| ツール | 説明 |
|--------|------|
| `search` | PubMed 検索（MeSH 対応、1-500件、ページネーション、構造化フィルタ、3段階の出力モード） |
| `fetch` | 単一 PMID のアブストラクト取得（HTML エンティティ自動デコード） |
| `fetch_batch` | 複数 PMID のアブストラクト一括取得（`include_abstract` で本文除外可） |
| `get_full_text` | PMC 全文取得(複数 PMCID + セクションフィルタ対応) |
| `count` | 検索ヒット数のみ取得（高速） |
| `find_similar_articles` | NCBI elink (`pubmed_pubmed`) ベースの類似論文検索 |
| `export_to_ris` | RIS 形式エクスポート（文献管理ソフト用） |
| `get_citation_counts` | iCite 引用数(default) / `citing_source: "pubmed"` で elink 経由 citing PMIDs |
| `convert_ids` | `{from_type, to_type, ids[]}` で PMID/PMCID/DOI を相互変換 |
| `batch_process` | 複数 PMID に対し abstract/citations/similar/ris_export/full_text を並列実行 |

### `search` 詳細パラメータ

| パラメータ | 型 | デフォルト | 説明 |
|---|---|---|---|
| `query` | string | — | クエリ(MeSH/フィールドタグ対応) |
| `retmax` | int | 50 | 1-500 |
| `retstart` | int | 0 | ページング開始位置 |
| `sort` | enum | `relevance` | `relevance` \| `pub_date` \| `first_author` |
| `output_mode` | enum | `compact` | `minimal`(id+title+url+full_text_available) \| `compact`(+著者/誌名/年/DOI/PMCID) \| `full`(+abstract/MeSH/publication_types) |
| `filters.date_range` | `{start?,end?}` | — | `"YYYY"` または `"YYYY/MM/DD"` |
| `filters.publication_types` | string[] | — | 例: `["Meta-Analysis","Randomized Controlled Trial"]` |
| `filters.languages` | string[] | — | ISO-3 言語(`eng`,`jpn`,…)。PubMed 言語名に変換 |
| `filters.humans_only` | bool | false | `"humans"[mh]` を AND |
| `filters.has_abstract` | bool | false | abstract のある文献のみ |
| `filters.free_full_text` | bool | false | 無料全文のみ |

レスポンスは `{total, showing, retstart, next_start, query_translation, sort, results[]}` 形式。`next_start` が `null` なら最終ページ。

#### 使用例

```jsonc
// 大量検索のスクリーニング(compact)
{
  "query": "\"deep learning\"[tiab] AND \"colonoscopy\"[mh]",
  "output_mode": "compact",
  "retmax": 50
}

// 構造化フィルタ + ページネーション
{
  "query": "diabetes",
  "filters": {
    "publication_types": ["Meta-Analysis"],
    "date_range": {"start": "2024"},
    "humans_only": true
  },
  "retmax": 50,
  "retstart": 50
}
```

### `get_full_text` 詳細

複数 PMCID を一度に処理し、必要なセクションだけ抽出してトークン使用量を削減できます。

```jsonc
{
  "pmcIds": ["PMC9167159", "9167160"],
  "sections": ["methods", "results"]   // ["all"] で全セクション(default)
}
```

利用可能セクション: `abstract`, `introduction`, `methods`, `results`, `discussion`, `conclusions`, `references`, `all`。

## 検索例

```
"COVID-19 AND vaccine"
"asthma[mh] AND adult[mh]"
"diabetes[tiab] AND 2023:2024[dp]"
"cancer treatment[majr]"
"lung cancer[mh] AND clinical trial[pt] AND 2024[dp]"
```

---

## アーキテクチャ

```
src/
├── index.ts           # エントリーポイント（OAuth + MCP ハンドラー）
├── tools.ts           # 9つの MCP ツール定義
├── pubmed-client.ts   # NCBI E-utilities API クライアント
└── ris-exporter.ts    # RIS 形式変換
```

- **トランスポート**: WebStandard Streamable HTTP（ステートレスモード）
- **認証**: OAuthProvider が MCP エンドポイントを保護、Google が ID プロバイダー
- **API**: NCBI E-utilities (esearch, esummary, efetch, elink) + iCite

---

## 設定一覧

| Secret | 必須 | 説明 |
|--------|------|------|
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth クライアント ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth クライアント シークレット |
| `COOKIE_ENCRYPTION_KEY` | Yes | Cookie 暗号化用の HEX 文字列（`openssl rand -hex 32` で生成） |
| `NCBI_API_KEY` | No | NCBI API キー（10 req/s、未設定時は 3 req/s） |

---

## トラブルシューティング

| 症状 | 原因と対処 |
|------|-----------|
| `invalid_token` エラー | OAuth トークンがない。MCP Inspector 経由で接続すると自動で OAuth 認証が走る |
| Google 認証後に `redirect_uri_mismatch` | リダイレクト URI が一致しない。Google Cloud Console の URI を再確認（末尾 `/callback` 必須） |
| `The OAuth client was not found` (401) | `GOOGLE_CLIENT_ID` が未設定または間違い。`npx wrangler secret put GOOGLE_CLIENT_ID` で再設定 |
| `Invalid or expired state` | 認証途中でタイムアウト（10分）。最初からやり直す |
| `OAUTH_KV assigned to multiple bindings` | `wrangler.jsonc` に同じ KV バインディングが 2 つある。1 つだけ残す |
| Worker 名を変更したら認証が壊れた | Secret は Worker 名に紐づく。新しい Worker に `wrangler secret put` で再設定が必要 |

---

## ライセンス

NCBI の利用規約に従ってください。E-utilities ガイドライン、PMC Open Access ライセンス条項、レートリミット要件を遵守してください。
