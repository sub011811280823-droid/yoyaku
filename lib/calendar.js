'use strict';

const DEFAULT_DURATION_MIN = 30;
const TZID = 'Asia/Tokyo';

// "2026-06-01","09:00" -> "20260601T090000"（タイムゾーン無し=ローカル時刻）
function toStamp(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-');
  const [hh, mm] = (timeStr || '00:00').split(':');
  return `${y}${m}${d}T${pad(hh)}${pad(mm)}00`;
}
function pad(n) { return String(n).padStart(2, '0'); }

// 終了時刻を分指定で加算
function addMinutes(dateStr, timeStr, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  const dt = new Date(y, m - 1, d, hh, mm + minutes);
  return {
    date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
    time: `${pad(dt.getHours())}:${pad(dt.getMinutes())}`,
  };
}

// 予約情報からイベント情報を組み立てる
function buildEvent(res, { tenantName, durationMin = DEFAULT_DURATION_MIN } = {}) {
  const end = addMinutes(res.slot_date, res.start_time, durationMin);
  const title = `健康診断（${res.course || ''}）`;
  const description =
    `${tenantName || ''} 健康診断のご予約\n` +
    `コース: ${res.course || ''}\n` +
    `受診者: ${res.name || ''}\n` +
    (res.self_pay != null ? `自己負担額: ${res.self_pay.toLocaleString()}円\n` : '');
  return {
    title,
    description,
    location: tenantName || '',
    startStamp: toStamp(res.slot_date, res.start_time),
    endStamp: toStamp(end.date, end.time),
    startISO: `${res.slot_date}T${res.start_time}:00`,
    endISO: `${end.date}T${end.time}:00`,
  };
}

// Googleカレンダー追加リンク
function googleUrl(ev) {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${ev.startStamp}/${ev.endStamp}`,
    details: ev.description,
    location: ev.location,
    ctz: TZID,
  });
  return 'https://calendar.google.com/calendar/render?' + p.toString();
}

// Outlook(Web)追加リンク
function outlookUrl(ev) {
  const p = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: ev.title,
    startdt: ev.startISO,
    enddt: ev.endISO,
    body: ev.description,
    location: ev.location,
  });
  return 'https://outlook.live.com/calendar/0/deeplink/compose?' + p.toString();
}

// Apple等向け .ics 本文
function icsBody(ev, uid) {
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//yoyaku//health-checkup//JP',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=${TZID}:${ev.startStamp}`,
    `DTEND;TZID=${TZID}:${ev.endStamp}`,
    `SUMMARY:${esc(ev.title)}`,
    `DESCRIPTION:${esc(ev.description)}`,
    `LOCATION:${esc(ev.location)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

// 予約完了メール本文（プレーンテキスト）を生成
function buildMailBody(res, links, { tenantName }) {
  return [
    `${res.name} 様`,
    '',
    `${tenantName} の健康診断のご予約を承りました。`,
    '',
    '【ご予約内容】',
    `  日時: ${res.slot_date} ${res.start_time}`,
    `  コース: ${res.course}`,
    res.options_total ? `  オプション合計: ${res.options_total.toLocaleString()}円` : null,
    `  自己負担額: ${(res.self_pay || 0).toLocaleString()}円`,
    '',
    '【カレンダーに追加】',
    `  Google カレンダー: ${links.google}`,
    `  Outlook:           ${links.outlook}`,
    `  Apple/iCal(.ics):  ${links.ics}`,
    '',
    'ご来院をお待ちしております。',
  ].filter((l) => l !== null).join('\n');
}

module.exports = { buildEvent, googleUrl, outlookUrl, icsBody, buildMailBody, DEFAULT_DURATION_MIN };
