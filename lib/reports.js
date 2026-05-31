'use strict';

const ExcelJS = require('exceljs');
const db = require('../db');

// ------------------------------------------------------------------
//  共通: CSV / XLSX 出力ヘルパー
// ------------------------------------------------------------------
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
// columns: [{header,key}], rows: [{key:val}]
function toCSV(columns, rows) {
  const head = columns.map((c) => csvEscape(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c.key])).join(',')).join('\n');
  return '﻿' + head + '\n' + body + '\n';
}
async function toXLSX(sheetName, columns, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 16 }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' } };
  rows.forEach((r) => ws.addRow(r));
  return wb.xlsx.writeBuffer();
}

// 確定予約を持つ employee_id の集合を返すサブクエリ
const RESERVED_EMP_SUBQUERY = `
  SELECT DISTINCT employee_id FROM reservations
  WHERE tenant_id = ? AND status = 'confirmed' AND employee_id IS NOT NULL`;

// 問診提出済み（予約に紐づく回答がある）employee_id の集合
const SUBMITTED_EMP_SUBQUERY = `
  SELECT DISTINCT r.employee_id
  FROM questionnaire_responses qr
  JOIN reservations r ON r.id = qr.reservation_id
  WHERE qr.tenant_id = ? AND r.employee_id IS NOT NULL`;

// ------------------------------------------------------------------
//  1. 進捗ダッシュボード
// ------------------------------------------------------------------
function dashboard(tenantId) {
  const total = db.prepare('SELECT COUNT(*) AS c FROM employees WHERE tenant_id = ? AND active = 1').get(tenantId).c;

  const reserved = db.prepare(
    `SELECT COUNT(*) AS c FROM employees e
     WHERE e.tenant_id = ? AND e.active = 1
       AND e.id IN (${RESERVED_EMP_SUBQUERY})`
  ).get(tenantId, tenantId).c;

  const submitted = db.prepare(
    `SELECT COUNT(*) AS c FROM employees e
     WHERE e.tenant_id = ? AND e.active = 1
       AND e.id IN (${SUBMITTED_EMP_SUBQUERY})`
  ).get(tenantId, tenantId).c;

  const pct = (n) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

  // 巡回健診日ごとの予約状況（定員・予約数・残・充足率）
  const byDate = db.prepare(
    `SELECT s.slot_date AS date,
            SUM(s.capacity) AS capacity,
            COALESCE(SUM(b.booked), 0) AS booked,
            COUNT(s.id) AS slot_count
     FROM slots s
     LEFT JOIN (
       SELECT slot_id, COUNT(*) AS booked FROM reservations
       WHERE status = 'confirmed' GROUP BY slot_id
     ) b ON b.slot_id = s.id
     WHERE s.tenant_id = ?
     GROUP BY s.slot_date
     ORDER BY s.slot_date`
  ).all(tenantId).map((d) => ({
    date: d.date,
    capacity: d.capacity,
    booked: d.booked,
    remaining: d.capacity - d.booked,
    slotCount: d.slot_count,
    fillRate: d.capacity > 0 ? Math.round((d.booked / d.capacity) * 1000) / 10 : 0,
  }));

  return {
    total,
    reserved, unreserved: total - reserved,
    reservedPct: pct(reserved), unreservedPct: pct(total - reserved),
    submitted, unsubmitted: total - submitted,
    submittedPct: pct(submitted), unsubmittedPct: pct(total - submitted),
    byDate,
  };
}

// ------------------------------------------------------------------
//  2. 未対応者の抽出
// ------------------------------------------------------------------
function unreservedEmployees(tenantId) {
  return db.prepare(
    `SELECT * FROM employees e
     WHERE e.tenant_id = ? AND e.active = 1
       AND e.id NOT IN (${RESERVED_EMP_SUBQUERY})
     ORDER BY e.department, e.employee_code, e.id`
  ).all(tenantId, tenantId);
}

function unsubmittedEmployees(tenantId) {
  return db.prepare(
    `SELECT * FROM employees e
     WHERE e.tenant_id = ? AND e.active = 1
       AND e.id NOT IN (${SUBMITTED_EMP_SUBQUERY})
     ORDER BY e.department, e.employee_code, e.id`
  ).all(tenantId, tenantId);
}

const EMP_COLUMNS = [
  { header: '社員番号', key: 'employee_code', width: 12 },
  { header: '氏名', key: 'name', width: 16 },
  { header: 'フリガナ', key: 'kana', width: 16 },
  { header: '部署', key: 'department', width: 14 },
  { header: 'メール', key: 'email', width: 22 },
  { header: '電話', key: 'phone', width: 14 },
];

// ------------------------------------------------------------------
//  3. 当日の受付名簿
// ------------------------------------------------------------------
function rosterRows(tenantId, date) {
  const rows = db.prepare(
    `SELECT r.id, r.name, r.kana, r.employee_id, r.gender,
            s.slot_date, s.start_time, c.name AS course,
            e.employee_code, e.department
     FROM reservations r
     JOIN slots s ON s.id = r.slot_id
     JOIN courses c ON c.id = s.course_id
     LEFT JOIN employees e ON e.id = r.employee_id
     WHERE r.tenant_id = ? AND r.status = 'confirmed' AND s.slot_date = ?
     ORDER BY s.start_time, c.name, r.kana`
  ).all(tenantId, date);

  const optStmt = db.prepare('SELECT name FROM reservation_options WHERE reservation_id = ?');
  return rows.map((r) => ({
    ...r,
    options: optStmt.all(r.id).map((o) => o.name).join(' / '),
  }));
}

const ROSTER_COLUMNS = [
  { header: '受付', key: '_blank', width: 6 },
  { header: '時間', key: 'start_time', width: 8 },
  { header: '社員番号', key: 'employee_code', width: 12 },
  { header: '氏名', key: 'name', width: 16 },
  { header: 'フリガナ', key: 'kana', width: 16 },
  { header: '部署', key: 'department', width: 14 },
  { header: '性別', key: 'gender', width: 6 },
  { header: 'コース', key: 'course', width: 16 },
  { header: 'オプション', key: 'options', width: 28 },
];

// ------------------------------------------------------------------
//  4. 問診結果の一括出力（健診機関向け・日付フィルタ可）
// ------------------------------------------------------------------
function questionnaireMatrix(tenantId, { date } = {}) {
  const params = [tenantId];
  let dateCond = '';
  if (date) { dateCond = ' AND s.slot_date = ?'; params.push(date); }

  const responses = db.prepare(
    `SELECT qr.id, qr.created_at,
            r.name AS respondent_name, r.kana AS respondent_kana, r.gender,
            e.employee_code, e.department,
            s.slot_date, s.start_time, c.name AS course
     FROM questionnaire_responses qr
     LEFT JOIN reservations r ON r.id = qr.reservation_id
     LEFT JOIN slots s ON s.id = r.slot_id
     LEFT JOIN courses c ON c.id = s.course_id
     LEFT JOIN employees e ON e.id = r.employee_id
     WHERE qr.tenant_id = ?${dateCond}
     ORDER BY s.slot_date, s.start_time, qr.id`
  ).all(...params);

  const ansStmt = db.prepare('SELECT label, value FROM answers WHERE response_id = ? ORDER BY id');
  const ordered = db.prepare('SELECT label FROM questions WHERE tenant_id = ? ORDER BY sort_order, id')
    .all(tenantId).map((q) => q.label);
  const labelSet = new Set(ordered);

  const rows = responses.map((resp) => {
    const map = {};
    for (const a of ansStmt.all(resp.id)) {
      let v = a.value;
      try { const p = JSON.parse(v); if (Array.isArray(p)) v = p.join('、'); } catch (_) {}
      map[a.label] = v;
      if (!labelSet.has(a.label)) { labelSet.add(a.label); ordered.push(a.label); }
    }
    return { resp, map };
  });
  return { questionLabels: ordered, rows };
}

// 健診機関向け: 受診者識別情報＋健診日時＋全質問
function questionnaireResultColumns(questionLabels) {
  return [
    { header: '受診日', key: 'slot_date', width: 12 },
    { header: '時間', key: 'start_time', width: 8 },
    { header: 'コース', key: 'course', width: 16 },
    { header: '社員番号', key: 'employee_code', width: 12 },
    { header: '氏名', key: 'name', width: 16 },
    { header: 'フリガナ', key: 'kana', width: 16 },
    { header: '性別', key: 'gender', width: 6 },
    { header: '部署', key: 'department', width: 14 },
    { header: '回答日時', key: 'created_at', width: 18 },
    ...questionLabels.map((l, i) => ({ header: l, key: 'q' + i, width: 20 })),
  ];
}
function questionnaireResultRows(questionLabels, matrixRows) {
  return matrixRows.map(({ resp, map }) => {
    const row = {
      slot_date: resp.slot_date || '', start_time: resp.start_time || '',
      course: resp.course || '', employee_code: resp.employee_code || '',
      name: resp.respondent_name || '', kana: resp.respondent_kana || '',
      gender: resp.gender || '', department: resp.department || '',
      created_at: resp.created_at,
    };
    questionLabels.forEach((l, i) => { row['q' + i] = map[l] ?? ''; });
    return row;
  });
}

// 健診日（巡回日）の一覧
function checkupDates(tenantId) {
  return db.prepare('SELECT DISTINCT slot_date FROM slots WHERE tenant_id = ? ORDER BY slot_date').all(tenantId).map((r) => r.slot_date);
}

module.exports = {
  csvEscape, toCSV, toXLSX,
  dashboard,
  unreservedEmployees, unsubmittedEmployees, EMP_COLUMNS,
  rosterRows, ROSTER_COLUMNS,
  questionnaireMatrix, questionnaireResultColumns, questionnaireResultRows,
  checkupDates,
};
