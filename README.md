# 健康診断 予約・問診アプリ (yoyaku) v2

複数企業に対応した**マルチテナント型**の健康診断 予約・問診システムです。
企業ごとにデータ・設定・ログインを分離し、スーパー管理者が企業を一括管理します。

## 画面構成

| 利用者 | URL | 役割 |
| --- | --- | --- |
| 受診者 | `/t/:slug` | 従業員ログイン後、コース・日付・時間枠・オプションを選び、自己負担額を確認して予約 |
| 受診者 | `/t/:slug/questionnaire` | 事前問診に回答（予約完了画面からも誘導） |
| 企業管理者 | `/admin/login` → `/admin` | 予約管理・予約枠・コース・オプション・問診設定・問診回答・各種設定 |
| スーパー管理者 | `/super/login` → `/super` | 企業（テナント）の追加・編集・削除、機能ON/OFF、補助額、PW再設定 |
| 案内 | `/` | ランディング（デモ用アカウント一覧） |

## 実装した機能

1. **予約完了メール＋カレンダー追加リンク** … Google カレンダー / Outlook / Apple(.ics) の3種類。
   完了画面にボタン表示し、メール本文はサーバーログに出力（※デモ環境のため実送信なし。SMTPは未接続）。
2. **オプション検査の選択** … 予約時に複数選択可能。料金に反映。
3. **補助額と自己負担額のリアルタイム表示** … 管理画面で補助額を設定。予約画面で
   `コース料金 + オプション − 補助額`（0円未満にはならない）を即時表示。
4. **条件付きオプション** … 管理画面でオプション名・金額・条件（性別／年齢範囲）を設定。
   条件に該当しない受診者は選択不可（UIで無効化＋サーバー側でも検証）。
5. **予約データのエクスポート** … 管理画面から CSV（UTF-8 BOM付き）／ XLSX をダウンロード。
6. **マルチテナント対応** … 企業ごとにログイン・設定・データを分離。スーパー管理者画面で企業を管理。
7. **予約完了後の問診導線** … 完了画面に「問診に進む」ボタン（予約IDを引き継ぎ）。
8. **企業ごとの機能ON/OFF** … 「予約機能を使う／問診機能を使う」を企業単位で切り替え。
   無効時は受診者画面でも案内表示。
9. **従業員マスタ** … 企業ごとに従業員を管理。
   - **ログイン方式を管理者が設定**：ログインID（社員番号 / メール）とパスワード（生年月日 / 社員番号 / 個別設定）を選択。
   - **個別補助額**：従業員ごとに補助額を割り当て（未設定なら企業既定を使用）。予約時に自動適用。
   - **補助額の一括置き換え**：検索条件に合致する従業員へまとめて適用。
   - **インポート/エクスポート**：CSV・XLSX。社員番号をキーに登録/更新（upsert）。
   - **検索・絞り込み**：キーワード（氏名・社員番号・メール）／部署／状態／補助額レンジ。
   - 予約は**従業員ログイン必須**（企業設定で切替可）。受診者情報は従業員マスタから自動入力。
10. **問診回答のエクスポート** … 問診回答を CSV / XLSX で出力（質問を列、回答を行にしたマトリクス形式）。
11. **マスタの編集** … 健診コース・オプション検査・問診項目を後から編集可能（名称・金額・条件・選択肢など）。
12. **モダンSaaS UI** … 刷新したデザインシステム（リファインしたカラートークン、ソフトシャドウ、
    セグメント型タブ、整ったテーブル/フォーム、トースト、レスポンシブ対応）。

## 技術構成

- **バックエンド**: Node.js + Express
- **DB**: SQLite（Node.js 標準 `node:sqlite`）
- **認証**: express-session（Cookieセッション）＋ scrypt によるパスワードハッシュ
- **XLSX生成**: exceljs
- **フロントエンド**: 素の HTML / CSS / JavaScript（ビルド不要）

## セットアップ

```bash
npm install
npm start      # http://localhost:3000
```

> **初回起動時、データベースが空ならデモデータ（企業2社・コース・オプション・問診・予約）を
> 自動投入します。** そのため `npm start` だけでデモ用アカウントでログインできます。
> 手動でデータを初期化したい場合は `npm run seed`（既存データを全削除して再投入）を実行してください。

環境変数: `PORT`（既定3000）, `DB_PATH`（既定 ./data.sqlite）, `SESSION_SECRET`。

> 旧バージョン(v1)の `data.sqlite` が残っているとスキーマ非互換で起動できません。
> その場合は `rm -f data.sqlite` で削除してから起動し直してください（起動時に明確なメッセージを表示します）。

## デモ用アカウント（`npm run seed` 後）

| 区分 | ID | パスワード | 入口 |
| --- | --- | --- | --- |
| スーパー管理者 | `superadmin` | `admin123` | `/super/login` |
| 企業A 管理者 | `demo-admin` | `admin123` | `/admin/login` |
| 企業A 受診者 | — | — | `/t/demo` |
| 企業B 管理者（予約OFF・問診のみ） | `clinicb-admin` | `admin123` | `/admin/login` |
| 企業B 受診者 | — | — | `/t/clinicb` |

## データモデル（概要）

- `tenants` … 企業。`subsidy`（補助額）, `use_reservation`, `use_questionnaire`
- `users` … 管理ユーザー（`tenant_id` が NULL ならスーパー管理者）。`password_hash` は `salt:hash`
- `courses` … コース（名称・料金）／ `slots` … 予約枠（日付×時間×コース×定員）
- `options` … オプション検査（金額・条件: 性別/年齢）
- `reservations` … 予約（料金スナップショット: course_price/options_total/subsidy/self_pay）
  ＋ `reservation_options`
- `questions` … 問診項目（type: text/textarea/number/radio/checkbox/select、choices、required、sort_order）
- `questionnaire_responses` ＋ `answers` … 問診回答

## API 概要

- 認証: `POST /api/auth/login` `{username,password,scope:'admin'|'super'}` / `POST /api/auth/logout` / `GET /api/auth/me`
- スーパー: `GET/POST/PATCH/DELETE /api/super/tenants[...]`, `POST /api/super/tenants/:id/reset-password`
- 企業管理: `/api/admin/{settings,courses,slots,options,questions,reservations,responses}`,
  `GET /api/admin/export.csv`, `GET /api/admin/export.xlsx`
- 受診者（slug別）: `GET /api/t/:slug/{info,courses,options,slots,questions}`,
  `POST /api/t/:slug/reservations`, `GET /api/t/:slug/reservations/:id/ics`,
  `POST /api/t/:slug/questionnaire`

## ディレクトリ

```
server.js            アプリ初期化・ルーティング
db.js                スキーマ定義・トランザクションヘルパー
seed.js              サンプルデータ投入
lib/
  auth.js            パスワードハッシュ・認証ミドルウェア
  pricing.js         年齢計算・オプション条件判定・自己負担額計算
  calendar.js        Google/Outlookリンク・.ics・メール本文生成
  export.js          CSV / XLSX 出力
routes/
  auth.js  super.js  admin.js  public.js
public/
  landing.html  login.html(+login.js)  super.html(+super.js)
  admin.html(+admin.js)  reserve.html(+reserve.js)  questionnaire.html(+questionnaire.js)
  common.js  style.css
```
