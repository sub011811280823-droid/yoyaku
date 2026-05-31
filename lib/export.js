'use strict';

const ExcelJS = require('exceljs');
const db = require('../db');

// テナントの予約データを行配列に整形
function reservationRows(tenantId) {
  const rows = db
    .prepare(
      `SELECT r.*, s.slot_date, s.start_time, c.name AS course
       FROM reservations r
       JOIN slots s ON s.id = r.slot_id
       JOIN courses c ON c.id = s.course_id
       WHERE r.tenant_id = ?
       ORDER BY s.slot_date, s.start_time, r.id`
    )
    .all(tenantId);

  const optStmt = db.prepare(
    'SELECT name, price FROM reservation_options WHERE reservation_id = ?'
  );

  return rows.map((r) => {
    const opts = optStmt.all(r.id);
    return {
      ...r,
      optionNames: opts.map((o) => o.name).join(' / '),
      status_ja: r.status === 'confirmed' ? '確定' : 'キャンセル',
    };
  });
}

const COLUMNS = [
  { header: '予約ID', key: 'id', width: 8 },
  { header: '受診日', key: 'slot_date', width: 12 },
  { header: '時間', key: 'start_time', width: 8 },
  { header: 'コース', key: 'course', width: 16 },
  { header: '氏名', key: 'name', width: 16 },
  { header: 'フリガナ', key: 'kana', width: 16 },
  { header: '生年月日', key: 'birthday', width: 12 },
  { header: '性別', key: 'gender', width: 6 },
  { header: '電話', key: 'phone', width: 14 },
  { header: 'メール', key: 'email', width: 22 },
  { header: 'オプション', key: 'optionNames', width: 24 },
  { header: 'コース料金', key: 'course_price', width: 10 },
  { header: 'オプション計', key: 'options_total', width: 10 },
  { header: '補助額', key: 'subsidy', width: 10 },
  { header: '自己負担額', key: 'self_pay', width: 10 },
  { header: '状態', key: 'status_ja', width: 10 },
  { header: '備考', key: 'note', width: 24 },
  { header: '登録日時', key: 'created_at', width: 18 },
];

// CSV文字列（Excelで文字化けしないようUTF-8 BOM付き）
function toCSV(tenantId) {
  const rows = reservationRows(tenantId);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = COLUMNS.map((c) => esc(c.header)).join(',');
  const body = rows.map((r) => COLUMNS.map((c) => esc(r[c.key])).join(',')).join('\n');
  return '﻿' + header + '\n' + body + '\n';
}

// XLSXバッファ
async function toXLSX(tenantId, tenantName) {
  const rows = reservationRows(tenantId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('予約一覧');
  ws.columns = COLUMNS;
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' } };
  rows.forEach((r) => ws.addRow(r));
  return wb.xlsx.writeBuffer();
}

module.exports = { toCSV, toXLSX, questionnaireCSV, questionnaireXLSX };

// ============ 問診回答のエクスポート ============
// 質問を列、回答セットを行にしたマトリクスを作る
function questionnaireMatrix(tenantId) {
  // 列となる質問（無効化された質問も過去回答に含まれうるので、回答ラベルから動的に収集）
  const responses = db
    .prepare(
      `SELECT qr.id, qr.created_at, r.name AS respondent_name
       FROM questionnaire_responses qr
       LEFT JOIN reservations r ON r.id = qr.reservation_id
       WHERE qr.tenant_id = ? ORDER BY qr.id`
    )
    .all(tenantId);

  const ansStmt = db.prepare('SELECT label, value FROM answers WHERE response_id = ? ORDER BY id');

  // 質問順を安定させるため questions テーブルの並び順を優先し、未知ラベルは後ろに追加
  const ordered = db
    .prepare('SELECT label FROM questions WHERE tenant_id = ? ORDER BY sort_order, id')
    .all(tenantId)
    .map((q) => q.label);
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

function questionnaireCSV(tenantId) {
  const { questionLabels, rows } = questionnaireMatrix(tenantId);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const headers = ['回答ID', '回答者', '回答日時', ...questionLabels];
  const lines = [headers.map(esc).join(',')];
  for (const { resp, map } of rows) {
    const base = [resp.id, resp.respondent_name || '', resp.created_at];
    const qs = questionLabels.map((l) => map[l] ?? '');
    lines.push([...base, ...qs].map(esc).join(','));
  }
  return '﻿' + lines.join('\n') + '\n';
}

async function questionnaireXLSX(tenantId) {
  const { questionLabels, rows } = questionnaireMatrix(tenantId);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('問診回答');
  ws.columns = [
    { header: '回答ID', key: '_id', width: 8 },
    { header: '回答者', key: '_name', width: 16 },
    { header: '回答日時', key: '_at', width: 18 },
    ...questionLabels.map((l, i) => ({ header: l, key: 'q' + i, width: 20 })),
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' } };
  for (const { resp, map } of rows) {
    const row = { _id: resp.id, _name: resp.respondent_name || '', _at: resp.created_at };
    questionLabels.forEach((l, i) => { row['q' + i] = map[l] ?? ''; });
    ws.addRow(row);
  }
  return wb.xlsx.writeBuffer();
}
