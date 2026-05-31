'use strict';

const ExcelJS = require('exceljs');
const db = require('../db');

// 従業員マスタの列定義（インポート/エクスポート共通）
const FIELDS = [
  { key: 'employee_code', header: '社員番号' },
  { key: 'name', header: '氏名' },
  { key: 'kana', header: 'フリガナ' },
  { key: 'email', header: 'メール' },
  { key: 'department', header: '部署' },
  { key: 'birthday', header: '生年月日' },
  { key: 'gender', header: '性別' },
  { key: 'phone', header: '電話' },
  { key: 'subsidy', header: '補助額' },
  { key: 'password', header: 'パスワード' },
  { key: 'active', header: '有効' },
];

// 実効補助額: 個別補助額があればそれ、無ければ企業既定
function effectiveSubsidy(employee, tenant) {
  if (employee && employee.subsidy != null) return employee.subsidy;
  return tenant.subsidy || 0;
}

// 従業員ログイン認証（テナント設定の login_id_field / password_field に従う）
function authenticate(tenant, loginId, password) {
  const field = tenant.login_id_field === 'email' ? 'email' : 'employee_code';
  const emp = db
    .prepare(`SELECT * FROM employees WHERE tenant_id = ? AND ${field} = ? AND active = 1`)
    .get(tenant.id, String(loginId || '').trim());
  if (!emp) return null;

  let expected;
  if (tenant.password_field === 'employee_code') expected = emp.employee_code;
  else if (tenant.password_field === 'custom') expected = emp.password;
  else expected = emp.birthday; // 既定: 生年月日
  if (expected == null || String(expected) === '') return null;
  return String(password) === String(expected) ? emp : null;
}

// ログイン方式の説明（受診者ログイン画面に表示）
function loginHint(tenant) {
  const id = tenant.login_id_field === 'email' ? 'メールアドレス' : '社員番号';
  const pw =
    tenant.password_field === 'employee_code' ? '社員番号'
    : tenant.password_field === 'custom' ? '管理者から配布されたパスワード'
    : '生年月日（例: 1985-04-10）';
  return { idLabel: id, passwordLabel: pw };
}

// ---- エクスポート ----
function rows(tenantId) {
  return db.prepare('SELECT * FROM employees WHERE tenant_id = ? ORDER BY id').all(tenantId);
}
function toCSV(tenantId) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = FIELDS.map((f) => esc(f.header)).join(',');
  const body = rows(tenantId)
    .map((r) => FIELDS.map((f) => esc(f.key === 'active' ? (r.active ? 1 : 0) : r[f.key])).join(','))
    .join('\n');
  return '﻿' + header + '\n' + body + '\n';
}
async function toXLSX(tenantId) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('従業員マスタ');
  ws.columns = FIELDS.map((f) => ({ header: f.header, key: f.key, width: 14 }));
  ws.getRow(1).font = { bold: true };
  rows(tenantId).forEach((r) => ws.addRow({ ...r, active: r.active ? 1 : 0 }));
  return wb.xlsx.writeBuffer();
}

// ---- インポート ----
// ヘッダー（日本語/英語キー）を内部キーへ対応付け
const HEADER_MAP = (() => {
  const m = {};
  FIELDS.forEach((f) => { m[f.header] = f.key; m[f.key] = f.key; });
  return m;
})();

function normalizeRow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = HEADER_MAP[String(k).trim()];
    if (key) out[key] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

function parseCSV(text) {
  // BOM除去・簡易CSVパーサ（ダブルクオート対応）
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i] ?? ''; });
    return o;
  });
}

async function parseXLSX(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers = [];
  ws.getRow(1).eachCell((cell, col) => { headers[col] = String(cell.value ?? '').trim(); });
  const out = [];
  ws.eachRow((r, n) => {
    if (n === 1) return;
    const o = {};
    r.eachCell((cell, col) => { if (headers[col]) o[headers[col]] = cell.value; });
    if (Object.keys(o).length) out.push(o);
  });
  return out;
}

// rawRows（オブジェクト配列）をupsert。employee_code基準。
function importRows(tenantId, rawRows) {
  let inserted = 0, updated = 0, skipped = 0;
  const findByCode = db.prepare('SELECT id FROM employees WHERE tenant_id = ? AND employee_code = ?');
  const insert = db.prepare(`INSERT INTO employees
    (tenant_id, employee_code, name, kana, email, department, birthday, gender, phone, subsidy, password, active)
    VALUES (@tenant_id,@employee_code,@name,@kana,@email,@department,@birthday,@gender,@phone,@subsidy,@password,@active)`);
  const update = db.prepare(`UPDATE employees SET
    employee_code=@employee_code, name=@name, kana=@kana, email=@email, department=@department,
    birthday=@birthday, gender=@gender, phone=@phone, subsidy=@subsidy, password=@password, active=@active
    WHERE id=@id`);

  db.tx(() => {
    for (const raw of rawRows) {
      const r = normalizeRow(raw);
      if (!r.name || String(r.name).trim() === '') { skipped++; continue; }
      const rec = {
        tenant_id: tenantId,
        employee_code: r.employee_code != null && r.employee_code !== '' ? String(r.employee_code) : null,
        name: String(r.name),
        kana: r.kana || null,
        email: r.email || null,
        department: r.department || null,
        birthday: r.birthday ? String(r.birthday).slice(0, 10) : null,
        gender: r.gender || null,
        phone: r.phone != null ? String(r.phone) : null,
        subsidy: r.subsidy === '' || r.subsidy == null ? null : Number(r.subsidy),
        password: r.password != null && r.password !== '' ? String(r.password) : null,
        active: r.active === '' || r.active == null ? 1 : (Number(r.active) ? 1 : 0),
      };
      const existing = rec.employee_code ? findByCode.get(tenantId, rec.employee_code) : null;
      if (existing) {
        const { tenant_id, ...rest } = rec;
        update.run({ ...rest, id: existing.id });
        updated++;
      } else { insert.run(rec); inserted++; }
    }
  });
  return { inserted, updated, skipped, total: rawRows.length };
}

module.exports = {
  FIELDS, effectiveSubsidy, authenticate, loginHint,
  toCSV, toXLSX, parseCSV, parseXLSX, importRows,
};
