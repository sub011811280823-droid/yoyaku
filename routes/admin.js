'use strict';

const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../lib/auth');
const { toCSV, toXLSX, questionnaireCSV, questionnaireXLSX } = require('../lib/export');
const emp = require('../lib/employees');
const reports = require('../lib/reports');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = express.Router();
router.use(requireAdmin);

function bad(res, msg) { return res.status(400).json({ error: msg }); }

// 残数付き予約枠SQL
const SLOT_SQL = `
  SELECT s.id, s.slot_date, s.start_time, s.capacity, s.course_id,
         c.name AS course, c.price AS course_price,
         COALESCE(b.booked, 0) AS booked,
         s.capacity - COALESCE(b.booked, 0) AS remaining
  FROM slots s
  JOIN courses c ON c.id = s.course_id
  LEFT JOIN (
    SELECT slot_id, COUNT(*) AS booked FROM reservations
    WHERE status = 'confirmed' GROUP BY slot_id
  ) b ON b.slot_id = s.id
`;

// ============ 自テナント情報・設定 ============
const SETTINGS_COLS = 'id, slug, name, subsidy, use_reservation, use_questionnaire, login_id_field, password_field, require_employee_login';
router.get('/settings', (req, res) => {
  res.json(db.prepare(`SELECT ${SETTINGS_COLS} FROM tenants WHERE id = ?`).get(req.tenantId));
});

router.patch('/settings', (req, res) => {
  const { subsidy, use_reservation, use_questionnaire, login_id_field, password_field, require_employee_login } = req.body || {};
  const loginField = ['employee_code', 'email'].includes(login_id_field) ? login_id_field : null;
  const pwField = ['birthday', 'employee_code', 'custom'].includes(password_field) ? password_field : null;
  db.prepare(
    `UPDATE tenants SET
       subsidy = COALESCE(?, subsidy),
       use_reservation = COALESCE(?, use_reservation),
       use_questionnaire = COALESCE(?, use_questionnaire),
       login_id_field = COALESCE(?, login_id_field),
       password_field = COALESCE(?, password_field),
       require_employee_login = COALESCE(?, require_employee_login)
     WHERE id = ?`
  ).run(
    subsidy == null ? null : Math.max(0, Number(subsidy)),
    use_reservation == null ? null : (use_reservation ? 1 : 0),
    use_questionnaire == null ? null : (use_questionnaire ? 1 : 0),
    loginField,
    pwField,
    require_employee_login == null ? null : (require_employee_login ? 1 : 0),
    req.tenantId
  );
  res.json(db.prepare(`SELECT ${SETTINGS_COLS} FROM tenants WHERE id = ?`).get(req.tenantId));
});

// ============ コース ============
router.get('/courses', (req, res) => {
  res.json(db.prepare('SELECT * FROM courses WHERE tenant_id = ? ORDER BY id').all(req.tenantId));
});
router.post('/courses', (req, res) => {
  const { name, price } = req.body || {};
  if (!name) return bad(res, 'コース名は必須です');
  try {
    const info = db.prepare('INSERT INTO courses (tenant_id, name, price) VALUES (?, ?, ?)')
      .run(req.tenantId, name, Math.max(0, Number(price) || 0));
    res.status(201).json(db.prepare('SELECT * FROM courses WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    return bad(res, String(e.message).includes('UNIQUE') ? '同名のコースが既にあります' : e.message);
  }
});
router.patch('/courses/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM courses WHERE id = ? AND tenant_id = ?').get(Number(req.params.id), req.tenantId);
  if (!c) return res.status(404).json({ error: 'コースが見つかりません' });
  const { name, price, active } = req.body || {};
  db.prepare('UPDATE courses SET name = COALESCE(?, name), price = COALESCE(?, price), active = COALESCE(?, active) WHERE id = ?')
    .run(name ?? null, price == null ? null : Math.max(0, Number(price)), active == null ? null : (active ? 1 : 0), c.id);
  res.json(db.prepare('SELECT * FROM courses WHERE id = ?').get(c.id));
});
router.delete('/courses/:id', (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS c FROM slots WHERE course_id = ? AND tenant_id = ?').get(id, req.tenantId).c;
  if (used > 0) return bad(res, 'このコースを使う予約枠があるため削除できません（先に枠を削除してください）');
  const info = db.prepare('DELETE FROM courses WHERE id = ? AND tenant_id = ?').run(id, req.tenantId);
  if (!info.changes) return res.status(404).json({ error: 'コースが見つかりません' });
  res.status(204).end();
});

// ============ 予約枠 ============
router.get('/slots', (req, res) => {
  const { date } = req.query;
  let sql = SLOT_SQL + ' WHERE s.tenant_id = $tid';
  const params = { tid: req.tenantId };
  if (date) { sql += ' AND s.slot_date = $date'; params.date = date; }
  sql += ' ORDER BY s.slot_date, s.start_time';
  res.json(db.prepare(sql).all(params));
});
router.post('/slots', (req, res) => {
  const { slot_date, start_time, course_id, capacity } = req.body || {};
  if (!slot_date || !start_time || !course_id) return bad(res, '日付・時間・コースは必須です');
  const cap = Number(capacity);
  if (!Number.isInteger(cap) || cap < 1) return bad(res, '定員は1以上で指定してください');
  const course = db.prepare('SELECT 1 FROM courses WHERE id = ? AND tenant_id = ?').get(Number(course_id), req.tenantId);
  if (!course) return bad(res, 'コースが不正です');
  try {
    const info = db.prepare('INSERT INTO slots (tenant_id, slot_date, start_time, course_id, capacity) VALUES (?, ?, ?, ?, ?)')
      .run(req.tenantId, slot_date, start_time, Number(course_id), cap);
    res.status(201).json(db.prepare(SLOT_SQL + ' WHERE s.id = $id').get({ id: info.lastInsertRowid }));
  } catch (e) {
    return bad(res, String(e.message).includes('UNIQUE') ? '同じ日付・時間・コースの枠が既にあります' : e.message);
  }
});
router.patch('/slots/:id', (req, res) => {
  const id = Number(req.params.id);
  const slot = db.prepare('SELECT * FROM slots WHERE id = ? AND tenant_id = ?').get(id, req.tenantId);
  if (!slot) return res.status(404).json({ error: '枠が見つかりません' });
  const cap = Number(req.body?.capacity);
  if (!Number.isInteger(cap) || cap < 1) return bad(res, '定員は1以上で指定してください');
  const booked = db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE slot_id = ? AND status='confirmed'`).get(id).c;
  if (cap < booked) return bad(res, `既に${booked}件の予約があるため、定員を${booked}未満にできません`);
  db.prepare('UPDATE slots SET capacity = ? WHERE id = ?').run(cap, id);
  res.json(db.prepare(SLOT_SQL + ' WHERE s.id = $id').get({ id }));
});
router.delete('/slots/:id', (req, res) => {
  const id = Number(req.params.id);
  const booked = db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE slot_id = ? AND status='confirmed'`).get(id).c;
  if (booked > 0) return bad(res, '確定済みの予約がある枠は削除できません');
  const info = db.prepare('DELETE FROM slots WHERE id = ? AND tenant_id = ?').run(id, req.tenantId);
  if (!info.changes) return res.status(404).json({ error: '枠が見つかりません' });
  res.status(204).end();
});

// ============ オプション検査 ============
router.get('/options', (req, res) => {
  res.json(db.prepare('SELECT * FROM options WHERE tenant_id = ? ORDER BY id').all(req.tenantId));
});
function parseOption(body) {
  return {
    name: body.name,
    price: Math.max(0, Number(body.price) || 0),
    cond_gender: ['男性', '女性'].includes(body.cond_gender) ? body.cond_gender : 'any',
    cond_min_age: body.cond_min_age === '' || body.cond_min_age == null ? null : Number(body.cond_min_age),
    cond_max_age: body.cond_max_age === '' || body.cond_max_age == null ? null : Number(body.cond_max_age),
  };
}
router.post('/options', (req, res) => {
  const o = parseOption(req.body || {});
  if (!o.name) return bad(res, 'オプション名は必須です');
  const info = db.prepare(
    'INSERT INTO options (tenant_id, name, price, cond_gender, cond_min_age, cond_max_age) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.tenantId, o.name, o.price, o.cond_gender, o.cond_min_age, o.cond_max_age);
  res.status(201).json(db.prepare('SELECT * FROM options WHERE id = ?').get(info.lastInsertRowid));
});
router.patch('/options/:id', (req, res) => {
  const opt = db.prepare('SELECT * FROM options WHERE id = ? AND tenant_id = ?').get(Number(req.params.id), req.tenantId);
  if (!opt) return res.status(404).json({ error: 'オプションが見つかりません' });
  const o = parseOption({ ...opt, ...req.body });
  const active = req.body.active == null ? opt.active : (req.body.active ? 1 : 0);
  db.prepare('UPDATE options SET name=?, price=?, cond_gender=?, cond_min_age=?, cond_max_age=?, active=? WHERE id=?')
    .run(o.name, o.price, o.cond_gender, o.cond_min_age, o.cond_max_age, active, opt.id);
  res.json(db.prepare('SELECT * FROM options WHERE id = ?').get(opt.id));
});
router.delete('/options/:id', (req, res) => {
  const info = db.prepare('DELETE FROM options WHERE id = ? AND tenant_id = ?').run(Number(req.params.id), req.tenantId);
  if (!info.changes) return res.status(404).json({ error: 'オプションが見つかりません' });
  res.status(204).end();
});

// ============ 問診の質問項目（ビルダー） ============
router.get('/questions', (req, res) => {
  res.json(db.prepare('SELECT * FROM questions WHERE tenant_id = ? ORDER BY sort_order, id').all(req.tenantId));
});
const QTYPES = ['text', 'textarea', 'number', 'radio', 'checkbox', 'select'];
function parseQuestion(body) {
  let choices = null;
  if (['radio', 'checkbox', 'select'].includes(body.type)) {
    const arr = Array.isArray(body.choices) ? body.choices
      : String(body.choices || '').split('\n').map((s) => s.trim()).filter(Boolean);
    choices = JSON.stringify(arr);
  }
  return {
    label: body.label,
    type: QTYPES.includes(body.type) ? body.type : 'text',
    choices,
    required: body.required ? 1 : 0,
    sort_order: Number(body.sort_order) || 0,
  };
}
router.post('/questions', (req, res) => {
  const q = parseQuestion(req.body || {});
  if (!q.label) return bad(res, '質問文は必須です');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM questions WHERE tenant_id = ?').get(req.tenantId).m;
  if (!q.sort_order) q.sort_order = maxOrder + 1;
  const info = db.prepare(
    'INSERT INTO questions (tenant_id, label, type, choices, required, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.tenantId, q.label, q.type, q.choices, q.required, q.sort_order);
  res.status(201).json(db.prepare('SELECT * FROM questions WHERE id = ?').get(info.lastInsertRowid));
});
router.patch('/questions/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM questions WHERE id = ? AND tenant_id = ?').get(Number(req.params.id), req.tenantId);
  if (!cur) return res.status(404).json({ error: '質問が見つかりません' });
  const q = parseQuestion({ ...cur, ...req.body, choices: req.body.choices ?? (cur.choices ? JSON.parse(cur.choices) : '') });
  const active = req.body.active == null ? cur.active : (req.body.active ? 1 : 0);
  db.prepare('UPDATE questions SET label=?, type=?, choices=?, required=?, sort_order=?, active=? WHERE id=?')
    .run(q.label, q.type, q.choices, q.required, q.sort_order, active, cur.id);
  res.json(db.prepare('SELECT * FROM questions WHERE id = ?').get(cur.id));
});
router.delete('/questions/:id', (req, res) => {
  const info = db.prepare('DELETE FROM questions WHERE id = ? AND tenant_id = ?').run(Number(req.params.id), req.tenantId);
  if (!info.changes) return res.status(404).json({ error: '質問が見つかりません' });
  res.status(204).end();
});

// ============ 予約管理 ============
router.get('/reservations', (req, res) => {
  const { date, status } = req.query;
  let sql = `
    SELECT r.*, s.slot_date, s.start_time, c.name AS course
    FROM reservations r
    JOIN slots s ON s.id = r.slot_id
    JOIN courses c ON c.id = s.course_id
    WHERE r.tenant_id = $tid`;
  const params = { tid: req.tenantId };
  if (date) { sql += ' AND s.slot_date = $date'; params.date = date; }
  if (status) { sql += ' AND r.status = $status'; params.status = status; }
  sql += ' ORDER BY s.slot_date, s.start_time, r.id';
  const rows = db.prepare(sql).all(params);
  const optStmt = db.prepare('SELECT name, price FROM reservation_options WHERE reservation_id = ?');
  rows.forEach((r) => { r.options = optStmt.all(r.id); });
  res.json(rows);
});
router.patch('/reservations/:id', (req, res) => {
  const id = Number(req.params.id);
  const r = db.prepare('SELECT * FROM reservations WHERE id = ? AND tenant_id = ?').get(id, req.tenantId);
  if (!r) return res.status(404).json({ error: '予約が見つかりません' });
  const { status } = req.body || {};
  if (!['confirmed', 'cancelled'].includes(status)) return bad(res, 'statusが不正です');
  if (status === 'confirmed' && r.status !== 'confirmed') {
    const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(r.slot_id);
    const booked = db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE slot_id = ? AND status='confirmed'`).get(r.slot_id).c;
    if (booked >= slot.capacity) return res.status(409).json({ error: 'この枠は満員のため確定に戻せません' });
  }
  db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, id);
  res.json(db.prepare('SELECT * FROM reservations WHERE id = ?').get(id));
});
router.delete('/reservations/:id', (req, res) => {
  const info = db.prepare('DELETE FROM reservations WHERE id = ? AND tenant_id = ?').run(Number(req.params.id), req.tenantId);
  if (!info.changes) return res.status(404).json({ error: '予約が見つかりません' });
  res.status(204).end();
});

// ============ 問診回答の閲覧 ============
router.get('/responses', (req, res) => {
  const responses = db.prepare(
    `SELECT qr.*, r.name AS respondent_name
     FROM questionnaire_responses qr
     LEFT JOIN reservations r ON r.id = qr.reservation_id
     WHERE qr.tenant_id = ? ORDER BY qr.id DESC`
  ).all(req.tenantId);
  const ansStmt = db.prepare('SELECT label, value FROM answers WHERE response_id = ? ORDER BY id');
  responses.forEach((r) => { r.answers = ansStmt.all(r.id); });
  res.json(responses);
});

// ============ エクスポート ============
router.get('/export.csv', (req, res) => {
  const csv = toCSV(req.tenantId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reservations.csv"');
  res.send(csv);
});
router.get('/export.xlsx', async (req, res) => {
  const t = db.prepare('SELECT name FROM tenants WHERE id = ?').get(req.tenantId);
  const buf = await toXLSX(req.tenantId, t.name);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="reservations.xlsx"');
  res.send(Buffer.from(buf));
});

// 問診回答のエクスポート
router.get('/responses/export.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="questionnaire.csv"');
  res.send(questionnaireCSV(req.tenantId));
});
router.get('/responses/export.xlsx', async (req, res) => {
  const buf = await questionnaireXLSX(req.tenantId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="questionnaire.xlsx"');
  res.send(Buffer.from(buf));
});

// ============ 従業員マスタ ============
// 検索・絞り込み条件を組み立てる
function empWhere(tenantId, query) {
  const where = ['tenant_id = $tid'];
  const params = { tid: tenantId };
  if (query.q) {
    where.push('(name LIKE $q OR kana LIKE $q OR employee_code LIKE $q OR email LIKE $q)');
    params.q = '%' + query.q + '%';
  }
  if (query.department) { where.push('department = $dep'); params.dep = query.department; }
  if (query.active === '1' || query.active === '0') { where.push('active = $act'); params.act = Number(query.active); }
  if (query.minSubsidy) { where.push('COALESCE(subsidy, -1) >= $min'); params.min = Number(query.minSubsidy); }
  if (query.maxSubsidy) { where.push('COALESCE(subsidy, 2147483647) <= $max'); params.max = Number(query.maxSubsidy); }
  return { sql: where.join(' AND '), params };
}

router.get('/employees', (req, res) => {
  const { sql, params } = empWhere(req.tenantId, req.query);
  const rows = db.prepare(`SELECT * FROM employees WHERE ${sql} ORDER BY employee_code, id`).all(params);
  res.json(rows);
});

router.get('/employees/departments', (req, res) => {
  const rows = db.prepare(`SELECT DISTINCT department FROM employees WHERE tenant_id = ? AND department IS NOT NULL AND department <> '' ORDER BY department`).all(req.tenantId);
  res.json(rows.map((r) => r.department));
});

function parseEmp(body) {
  return {
    employee_code: body.employee_code ? String(body.employee_code).trim() : null,
    name: body.name ? String(body.name).trim() : '',
    kana: body.kana || null,
    email: body.email || null,
    department: body.department || null,
    birthday: body.birthday ? String(body.birthday).slice(0, 10) : null,
    gender: ['男性', '女性', 'その他'].includes(body.gender) ? body.gender : null,
    phone: body.phone || null,
    subsidy: body.subsidy === '' || body.subsidy == null ? null : Math.max(0, Number(body.subsidy)),
    password: body.password ? String(body.password) : null,
  };
}

router.post('/employees', (req, res) => {
  const e = parseEmp(req.body || {});
  if (!e.name) return bad(res, '氏名は必須です');
  try {
    const info = db.prepare(`INSERT INTO employees
      (tenant_id, employee_code, name, kana, email, department, birthday, gender, phone, subsidy, password)
      VALUES (@tenant_id,@employee_code,@name,@kana,@email,@department,@birthday,@gender,@phone,@subsidy,@password)`)
      .run({ ...e, tenant_id: req.tenantId });
    res.status(201).json(db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    return bad(res, String(err.message).includes('UNIQUE') ? '同じ社員番号が既に存在します' : err.message);
  }
});

router.patch('/employees/:id', (req, res) => {
  const cur = db.prepare('SELECT * FROM employees WHERE id = ? AND tenant_id = ?').get(Number(req.params.id), req.tenantId);
  if (!cur) return res.status(404).json({ error: '従業員が見つかりません' });
  // active のみの切替も許可
  if (Object.keys(req.body || {}).length === 1 && req.body.active != null) {
    db.prepare('UPDATE employees SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, cur.id);
    return res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(cur.id));
  }
  const e = parseEmp({ ...cur, ...req.body });
  const active = req.body.active == null ? cur.active : (req.body.active ? 1 : 0);
  try {
    db.prepare(`UPDATE employees SET
      employee_code=@employee_code, name=@name, kana=@kana, email=@email, department=@department,
      birthday=@birthday, gender=@gender, phone=@phone, subsidy=@subsidy, password=@password, active=@active
      WHERE id=@id`).run({ ...e, active, id: cur.id });
    res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(cur.id));
  } catch (err) {
    return bad(res, String(err.message).includes('UNIQUE') ? '同じ社員番号が既に存在します' : err.message);
  }
});

router.delete('/employees/:id', (req, res) => {
  const info = db.prepare('DELETE FROM employees WHERE id = ? AND tenant_id = ?').run(Number(req.params.id), req.tenantId);
  if (!info.changes) return res.status(404).json({ error: '従業員が見つかりません' });
  res.status(204).end();
});

// 補助額の一括置き換え（絞り込み条件に合致する従業員すべてに適用）
router.post('/employees/bulk-subsidy', (req, res) => {
  const subsidy = Number(req.body?.subsidy);
  if (!Number.isFinite(subsidy) || subsidy < 0) return bad(res, '補助額は0以上で指定してください');
  const { sql, params } = empWhere(req.tenantId, req.body?.filter || {});
  const info = db.prepare(`UPDATE employees SET subsidy = $sub WHERE ${sql}`).run({ ...params, sub: subsidy });
  res.json({ updated: info.changes });
});

// インポート（CSV / XLSX）
router.post('/employees/import', upload.single('file'), async (req, res) => {
  if (!req.file) return bad(res, 'ファイルが選択されていません');
  const name = (req.file.originalname || '').toLowerCase();
  try {
    let rows;
    if (name.endsWith('.xlsx')) rows = await emp.parseXLSX(req.file.buffer);
    else rows = emp.parseCSV(req.file.buffer.toString('utf8'));
    const result = emp.importRows(req.tenantId, rows);
    res.json(result);
  } catch (e) {
    return bad(res, 'インポートに失敗しました: ' + e.message);
  }
});

// エクスポート
router.get('/employees/export.csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
  res.send(emp.toCSV(req.tenantId));
});
router.get('/employees/export.xlsx', async (req, res) => {
  const buf = await emp.toXLSX(req.tenantId);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="employees.xlsx"');
  res.send(Buffer.from(buf));
});

// ============ 進捗ダッシュボード・帳票 ============

// ファイル名にタイムスタンプ等を付けて送出するヘルパー
function sendCSV(res, filename, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}
function sendXLSX(res, filename, buf) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(Buffer.from(buf));
}

// 1. 進捗ダッシュボード（集計JSON）
router.get('/dashboard', (req, res) => {
  res.json(reports.dashboard(req.tenantId));
});

// 健診日（巡回日）一覧 — 帳票の絞り込み用
router.get('/checkup-dates', (req, res) => {
  res.json(reports.checkupDates(req.tenantId));
});

// 2. 未対応者の一覧（JSON）
router.get('/reports/unreserved', (req, res) => {
  res.json(reports.unreservedEmployees(req.tenantId));
});
router.get('/reports/unsubmitted', (req, res) => {
  res.json(reports.unsubmittedEmployees(req.tenantId));
});

// 2. 未対応者の出力（CSV/XLSX）
router.get('/reports/unreserved.csv', (req, res) => {
  sendCSV(res, 'unreserved.csv', reports.toCSV(reports.EMP_COLUMNS, reports.unreservedEmployees(req.tenantId)));
});
router.get('/reports/unreserved.xlsx', async (req, res) => {
  sendXLSX(res, 'unreserved.xlsx', await reports.toXLSX('未予約者', reports.EMP_COLUMNS, reports.unreservedEmployees(req.tenantId)));
});
router.get('/reports/unsubmitted.csv', (req, res) => {
  sendCSV(res, 'unsubmitted.csv', reports.toCSV(reports.EMP_COLUMNS, reports.unsubmittedEmployees(req.tenantId)));
});
router.get('/reports/unsubmitted.xlsx', async (req, res) => {
  sendXLSX(res, 'unsubmitted.xlsx', await reports.toXLSX('問診未提出者', reports.EMP_COLUMNS, reports.unsubmittedEmployees(req.tenantId)));
});

// 3. 当日受付名簿（JSON / CSV / XLSX）— date必須
router.get('/reports/roster', (req, res) => {
  if (!req.query.date) return bad(res, '健診日(date)を指定してください');
  res.json(reports.rosterRows(req.tenantId, req.query.date));
});
router.get('/reports/roster.csv', (req, res) => {
  const date = req.query.date;
  if (!date) return bad(res, '健診日(date)を指定してください');
  sendCSV(res, `roster_${date}.csv`, reports.toCSV(reports.ROSTER_COLUMNS, reports.rosterRows(req.tenantId, date)));
});
router.get('/reports/roster.xlsx', async (req, res) => {
  const date = req.query.date;
  if (!date) return bad(res, '健診日(date)を指定してください');
  sendXLSX(res, `roster_${date}.xlsx`, await reports.toXLSX(`受付名簿_${date}`, reports.ROSTER_COLUMNS, reports.rosterRows(req.tenantId, date)));
});

// 4. 問診結果の一括出力（健診機関向け・date絞り込み可）
router.get('/reports/questionnaire-results.csv', (req, res) => {
  const { questionLabels, rows } = reports.questionnaireMatrix(req.tenantId, { date: req.query.date });
  const cols = reports.questionnaireResultColumns(questionLabels);
  const data = reports.questionnaireResultRows(questionLabels, rows);
  const suffix = req.query.date ? '_' + req.query.date : '';
  sendCSV(res, `questionnaire_results${suffix}.csv`, reports.toCSV(cols, data));
});
router.get('/reports/questionnaire-results.xlsx', async (req, res) => {
  const { questionLabels, rows } = reports.questionnaireMatrix(req.tenantId, { date: req.query.date });
  const cols = reports.questionnaireResultColumns(questionLabels);
  const data = reports.questionnaireResultRows(questionLabels, rows);
  const suffix = req.query.date ? '_' + req.query.date : '';
  sendXLSX(res, `questionnaire_results${suffix}.xlsx`, await reports.toXLSX('問診結果', cols, data));
});

module.exports = router;
