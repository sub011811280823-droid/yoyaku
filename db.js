'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

// 旧バージョン(v1)のDBが残っていると、新スキーマと衝突してクラッシュするため
// 互換性のないスキーマを検出して分かりやすいメッセージで停止する。
const slotsCols = db.prepare("PRAGMA table_info('slots')").all();
if (slotsCols.length && !slotsCols.some((c) => c.name === 'tenant_id')) {
  throw new Error(
    '\n旧バージョンの data.sqlite が検出されました（スキーマが非互換です）。\n' +
    'お手数ですが data.sqlite を削除してから起動し直してください:\n' +
    '  rm -f data.sqlite && npm start\n'
  );
}

// ------------------------------------------------------------------
//  スキーマ（マルチテナント対応）
// ------------------------------------------------------------------
db.exec(`
  -- 企業（テナント）
  CREATE TABLE IF NOT EXISTS tenants (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    slug              TEXT    NOT NULL UNIQUE,   -- 受診者用URL /t/:slug
    name              TEXT    NOT NULL,
    subsidy           INTEGER NOT NULL DEFAULT 0, -- 補助額(円/件)
    use_reservation   INTEGER NOT NULL DEFAULT 1, -- 予約機能を使う
    use_questionnaire INTEGER NOT NULL DEFAULT 1, -- 問診機能を使う
    created_at        TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );

  -- 管理ユーザー（tenant_id が NULL ならスーパー管理者）
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,             -- scrypt: salt:hash
    role          TEXT    NOT NULL,             -- 'super' | 'admin'
    name          TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  );

  -- 健診コース（テナントごと）
  CREATE TABLE IF NOT EXISTS courses (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name      TEXT    NOT NULL,
    price     INTEGER NOT NULL DEFAULT 0,
    active    INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    UNIQUE (tenant_id, name)
  );

  -- 予約枠（テナントごと）
  CREATE TABLE IF NOT EXISTS slots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  INTEGER NOT NULL,
    slot_date  TEXT    NOT NULL,   -- YYYY-MM-DD
    start_time TEXT    NOT NULL,   -- HH:MM
    course_id  INTEGER NOT NULL,
    capacity   INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    UNIQUE (tenant_id, slot_date, start_time, course_id)
  );

  -- オプション検査（テナントごと・条件付き）
  CREATE TABLE IF NOT EXISTS options (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    price        INTEGER NOT NULL DEFAULT 0,
    cond_gender  TEXT    NOT NULL DEFAULT 'any', -- 'any' | '男性' | '女性'
    cond_min_age INTEGER,                        -- 下限年齢(任意)
    cond_max_age INTEGER,                        -- 上限年齢(任意)
    active       INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  );

  -- 従業員マスタ（テナントごと）
  CREATE TABLE IF NOT EXISTS employees (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL,
    employee_code TEXT,                 -- 社員番号
    name          TEXT    NOT NULL,
    kana          TEXT,
    email         TEXT,
    department    TEXT,
    birthday      TEXT,
    gender        TEXT,
    phone         TEXT,
    subsidy       INTEGER,              -- 個別補助額（NULLなら企業既定を使用）
    password      TEXT,                 -- 個別設定パスワード（password_field=custom用）
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    UNIQUE (tenant_id, employee_code)
  );

  -- 予約
  CREATE TABLE IF NOT EXISTS reservations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL,
    slot_id       INTEGER NOT NULL,
    name          TEXT    NOT NULL,
    kana          TEXT    NOT NULL,
    birthday      TEXT,
    gender        TEXT,
    phone         TEXT    NOT NULL,
    email         TEXT,
    note          TEXT,
    status        TEXT    NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled
    course_price  INTEGER NOT NULL DEFAULT 0,  -- スナップショット
    options_total INTEGER NOT NULL DEFAULT 0,
    subsidy       INTEGER NOT NULL DEFAULT 0,
    self_pay      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
    FOREIGN KEY (slot_id)   REFERENCES slots(id)   ON DELETE CASCADE
  );

  -- 予約に紐づくオプション（スナップショット）
  CREATE TABLE IF NOT EXISTS reservation_options (
    reservation_id INTEGER NOT NULL,
    option_id      INTEGER,
    name           TEXT    NOT NULL,
    price          INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE
  );

  -- 問診の質問項目（テナントごと・ビルダーで設定）
  CREATE TABLE IF NOT EXISTS questions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  INTEGER NOT NULL,
    label      TEXT    NOT NULL,
    type       TEXT    NOT NULL,            -- text|textarea|number|radio|checkbox|select
    choices    TEXT,                        -- JSON配列（radio/checkbox/select用）
    required   INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  );

  -- 問診の回答（1回答 = 1セット）
  CREATE TABLE IF NOT EXISTS questionnaire_responses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id      INTEGER NOT NULL,
    reservation_id INTEGER,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (tenant_id)      REFERENCES tenants(id)      ON DELETE CASCADE,
    FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS answers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    response_id INTEGER NOT NULL,
    question_id INTEGER,
    label       TEXT,                        -- 質問文スナップショット
    value       TEXT,                        -- 回答（checkboxはJSON配列）
    FOREIGN KEY (response_id) REFERENCES questionnaire_responses(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_slots_tenant_date ON slots(tenant_id, slot_date);
  CREATE INDEX IF NOT EXISTS idx_res_tenant ON reservations(tenant_id);
  CREATE INDEX IF NOT EXISTS idx_resopt ON reservation_options(reservation_id);
  CREATE INDEX IF NOT EXISTS idx_emp_tenant ON employees(tenant_id);
`);

// ------------------------------------------------------------------
//  既存DB向けの軽量マイグレーション（カラム追加）
// ------------------------------------------------------------------
function ensureColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all();
  if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// 従業員ログインの方式（テナントごと）
ensureColumn('tenants', 'login_id_field', "login_id_field TEXT NOT NULL DEFAULT 'employee_code'"); // employee_code | email
ensureColumn('tenants', 'password_field', "password_field TEXT NOT NULL DEFAULT 'birthday'");       // birthday | employee_code | custom
ensureColumn('tenants', 'require_employee_login', 'require_employee_login INTEGER NOT NULL DEFAULT 1');
// 予約に従業員を紐付け
ensureColumn('reservations', 'employee_id', 'employee_id INTEGER');

// 簡易トランザクションヘルパー
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

module.exports = db;
module.exports.tx = tx;
