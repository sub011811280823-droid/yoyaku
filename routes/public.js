'use strict';

const express = require('express');
const db = require('../db');
const { ageAt, isEligible, conditionLabel, computeCost } = require('../lib/pricing');
const cal = require('../lib/calendar');
const emp = require('../lib/employees');

const router = express.Router();

// :slug からテナントを解決
router.use('/:slug', (req, res, next) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
  if (!tenant) return res.status(404).json({ error: '企業が見つかりません' });
  req.tenant = tenant;
  next();
});

function bad(res, msg) { return res.status(400).json({ error: msg }); }

// セッションからこのテナントの従業員を取得
function currentEmployee(req) {
  const s = req.session && req.session.employee;
  if (!s || s.tenantId !== req.tenant.id) return null;
  return db.prepare('SELECT * FROM employees WHERE id = ? AND tenant_id = ? AND active = 1').get(s.id, req.tenant.id);
}

function publicEmployee(e, tenant) {
  return {
    id: e.id, employee_code: e.employee_code, name: e.name, kana: e.kana,
    email: e.email, department: e.department, birthday: e.birthday, gender: e.gender,
    phone: e.phone, subsidy: emp.effectiveSubsidy(e, tenant),
  };
}

// テナント基本情報（機能フラグ・補助額・ログイン方式）
router.get('/:slug/info', (req, res) => {
  const t = req.tenant;
  res.json({
    slug: t.slug, name: t.name, subsidy: t.subsidy,
    use_reservation: !!t.use_reservation, use_questionnaire: !!t.use_questionnaire,
    require_employee_login: !!t.require_employee_login,
    loginHint: emp.loginHint(t),
  });
});

// ============ 従業員ログイン ============
router.post('/:slug/employee/login', (req, res) => {
  const { loginId, password } = req.body || {};
  if (!loginId || !password) return bad(res, 'ログインIDとパスワードを入力してください');
  const e = emp.authenticate(req.tenant, loginId, password);
  if (!e) return res.status(401).json({ error: 'ログインIDまたはパスワードが違います' });
  req.session.employee = { tenantId: req.tenant.id, id: e.id };
  res.json(publicEmployee(e, req.tenant));
});

router.get('/:slug/employee/me', (req, res) => {
  const e = currentEmployee(req);
  res.json(e ? publicEmployee(e, req.tenant) : null);
});

router.post('/:slug/employee/logout', (req, res) => {
  if (req.session) req.session.employee = null;
  res.json({ ok: true });
});

// コース（有効のみ）
router.get('/:slug/courses', (req, res) => {
  res.json(db.prepare('SELECT id, name, price FROM courses WHERE tenant_id = ? AND active = 1 ORDER BY id').all(req.tenant.id));
});

// オプション（有効のみ・条件ラベル付き）
router.get('/:slug/options', (req, res) => {
  const opts = db.prepare('SELECT * FROM options WHERE tenant_id = ? AND active = 1 ORDER BY id').all(req.tenant.id);
  res.json(opts.map((o) => ({
    id: o.id, name: o.name, price: o.price,
    cond_gender: o.cond_gender, cond_min_age: o.cond_min_age, cond_max_age: o.cond_max_age,
    conditionLabel: conditionLabel(o),
  })));
});

// 予約枠（残数付き）
router.get('/:slug/slots', (req, res) => {
  const { date, course_id } = req.query;
  let sql = `
    SELECT s.id, s.slot_date, s.start_time, s.capacity, c.name AS course, c.id AS course_id, c.price AS course_price,
           COALESCE(b.booked,0) AS booked, s.capacity - COALESCE(b.booked,0) AS remaining
    FROM slots s JOIN courses c ON c.id = s.course_id
    LEFT JOIN (SELECT slot_id, COUNT(*) AS booked FROM reservations WHERE status='confirmed' GROUP BY slot_id) b ON b.slot_id = s.id
    WHERE s.tenant_id = $tid AND c.active = 1`;
  const params = { tid: req.tenant.id };
  if (date) { sql += ' AND s.slot_date = $date'; params.date = date; }
  if (course_id) { sql += ' AND s.course_id = $cid'; params.cid = Number(course_id); }
  sql += ' ORDER BY s.slot_date, s.start_time';
  res.json(db.prepare(sql).all(params));
});

// 予約作成（従業員ログイン必須・個別補助額を適用）
router.post('/:slug/reservations', (req, res) => {
  const t = req.tenant;
  if (!t.use_reservation) return res.status(403).json({ error: 'この企業では予約機能が無効です' });

  const employee = currentEmployee(req);
  if (t.require_employee_login && !employee) {
    return res.status(401).json({ error: '従業員ログインが必要です' });
  }

  const { slot_id, name, kana, phone, birthday, gender, email, note, option_ids } = req.body || {};
  if (!slot_id || !name || !kana || !phone) return bad(res, '氏名・フリガナ・電話番号・予約枠は必須です');

  const slot = db.prepare(
    'SELECT s.*, c.price AS course_price, c.name AS course FROM slots s JOIN courses c ON c.id=s.course_id WHERE s.id = ? AND s.tenant_id = ?'
  ).get(Number(slot_id), t.id);
  if (!slot) return bad(res, '指定の予約枠が存在しません');

  const age = ageAt(birthday, slot.slot_date);
  const selectedIds = Array.isArray(option_ids) ? option_ids.map(Number) : [];
  const selectedOptions = [];
  for (const oid of selectedIds) {
    const o = db.prepare('SELECT * FROM options WHERE id = ? AND tenant_id = ? AND active = 1').get(oid, t.id);
    if (!o) return bad(res, '選択されたオプションが不正です');
    if (!isEligible(o, { gender, age })) {
      return bad(res, `「${o.name}」は条件（${conditionLabel(o)}）に該当しないため選択できません`);
    }
    selectedOptions.push(o);
  }

  // 補助額: 従業員がいれば個別補助額、無ければ企業既定
  const subsidy = employee ? emp.effectiveSubsidy(employee, t) : (t.subsidy || 0);
  const cost = computeCost({
    coursePrice: slot.course_price,
    optionPrices: selectedOptions.map((o) => o.price),
    subsidy,
  });

  try {
    const newId = db.tx(() => {
      const booked = db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE slot_id = ? AND status='confirmed'`).get(slot.id).c;
      if (booked >= slot.capacity) { const e = new Error('FULL'); e.full = true; throw e; }
      const info = db.prepare(
        `INSERT INTO reservations
          (tenant_id, slot_id, employee_id, name, kana, birthday, gender, phone, email, note,
           course_price, options_total, subsidy, self_pay)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        t.id, slot.id, employee ? employee.id : null, name, kana, birthday || null, gender || null, phone, email || null, note || null,
        cost.coursePrice, cost.optionsTotal, cost.subsidy, cost.selfPay
      );
      const rid = info.lastInsertRowid;
      const insOpt = db.prepare('INSERT INTO reservation_options (reservation_id, option_id, name, price) VALUES (?, ?, ?, ?)');
      selectedOptions.forEach((o) => insOpt.run(rid, o.id, o.name, o.price));
      return rid;
    });

    const created = db.prepare(
      `SELECT r.*, s.slot_date, s.start_time, c.name AS course
       FROM reservations r JOIN slots s ON s.id=r.slot_id JOIN courses c ON c.id=s.course_id WHERE r.id = ?`
    ).get(newId);

    const ev = cal.buildEvent(created, { tenantName: t.name });
    const base = `${req.protocol}://${req.get('host')}`;
    const links = {
      google: cal.googleUrl(ev),
      outlook: cal.outlookUrl(ev),
      ics: `${base}/api/t/${t.slug}/reservations/${created.id}/ics`,
    };
    if (created.email) {
      const body = cal.buildMailBody(created, links, { tenantName: t.name });
      console.log(`\n===== 予約完了メール (to: ${created.email}) =====\n${body}\n==========================================\n`);
    }

    res.status(201).json({ reservation: created, links, useQuestionnaire: !!t.use_questionnaire });
  } catch (e) {
    if (e.full) return res.status(409).json({ error: 'この枠は満員です。別の枠をお選びください' });
    throw e;
  }
});

// .ics ダウンロード
router.get('/:slug/reservations/:id/ics', (req, res) => {
  const r = db.prepare(
    `SELECT r.*, s.slot_date, s.start_time, c.name AS course
     FROM reservations r JOIN slots s ON s.id=r.slot_id JOIN courses c ON c.id=s.course_id
     WHERE r.id = ? AND r.tenant_id = ?`
  ).get(Number(req.params.id), req.tenant.id);
  if (!r) return res.status(404).json({ error: '予約が見つかりません' });
  const ev = cal.buildEvent(r, { tenantName: req.tenant.name });
  const ics = cal.icsBody(ev, `res-${r.id}@${req.tenant.slug}`);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="kenshin-${r.id}.ics"`);
  res.send(ics);
});

// ============ 問診（受診者側） ============
router.get('/:slug/questions', (req, res) => {
  if (!req.tenant.use_questionnaire) return res.status(403).json({ error: 'この企業では問診機能が無効です' });
  const qs = db.prepare('SELECT id, label, type, choices, required, sort_order FROM questions WHERE tenant_id = ? AND active = 1 ORDER BY sort_order, id').all(req.tenant.id);
  res.json(qs.map((q) => ({ ...q, choices: q.choices ? JSON.parse(q.choices) : [] })));
});

router.post('/:slug/questionnaire', (req, res) => {
  const t = req.tenant;
  if (!t.use_questionnaire) return res.status(403).json({ error: 'この企業では問診機能が無効です' });
  const { reservation_id, answers } = req.body || {};
  if (!answers || typeof answers !== 'object') return bad(res, '回答がありません');

  const questions = db.prepare('SELECT * FROM questions WHERE tenant_id = ? AND active = 1').all(t.id);
  for (const q of questions) {
    if (q.required) {
      const v = answers[q.id];
      const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
      if (empty) return bad(res, `「${q.label}」は必須です`);
    }
  }

  const rid = db.tx(() => {
    let resId = null;
    if (reservation_id) {
      const r = db.prepare('SELECT id FROM reservations WHERE id = ? AND tenant_id = ?').get(Number(reservation_id), t.id);
      if (r) resId = r.id;
    }
    const info = db.prepare('INSERT INTO questionnaire_responses (tenant_id, reservation_id) VALUES (?, ?)').run(t.id, resId);
    const respId = info.lastInsertRowid;
    const ins = db.prepare('INSERT INTO answers (response_id, question_id, label, value) VALUES (?, ?, ?, ?)');
    for (const q of questions) {
      let v = answers[q.id];
      if (v == null) continue;
      if (Array.isArray(v)) v = JSON.stringify(v);
      ins.run(respId, q.id, q.label, String(v));
    }
    return respId;
  });
  res.status(201).json({ id: rid, ok: true });
});

module.exports = router;
