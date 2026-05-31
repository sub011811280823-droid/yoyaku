'use strict';

const slug = getSlug();
let tenant = null;
let employee = null;
let effectiveSubsidy = 0;
let courses = [];
let options = [];
let slots = [];
let selectedSlot = null;

const $ = (id) => document.getElementById(id);

(async function init() {
  if (!slug) { document.body.innerHTML = '<main><div class="card">URLが不正です。</div></main>'; return; }
  try {
    tenant = await api(`/api/t/${slug}/info`);
  } catch (e) {
    document.body.innerHTML = `<main><div class="card">企業が見つかりません（${esc(slug)}）。</div></main>`;
    return;
  }
  $('tenant-name').textContent = `${tenant.name} 健康診断 予約`;
  document.title = `${tenant.name} 健康診断 予約`;

  if (!tenant.use_reservation) {
    $('res-off').classList.remove('hidden');
    if (tenant.use_questionnaire) {
      $('off-questionnaire').classList.remove('hidden');
      $('off-q-link').href = `/t/${slug}/questionnaire`;
    }
    return;
  }

  // 従業員ログイン状態を確認
  try { employee = await api(`/api/t/${slug}/employee/me`); } catch { employee = null; }

  if (tenant.require_employee_login && !employee) {
    showLogin();
  } else {
    await startReserve();
  }
})();

function showLogin() {
  $('emp-login').classList.remove('hidden');
  $('reserve-ui').classList.add('hidden');
  const h = tenant.loginHint || { idLabel: 'ログインID', passwordLabel: 'パスワード' };
  $('lbl-loginid').textContent = `ログインID（${h.idLabel}）`;
  $('lbl-pw').textContent = `パスワード（${h.passwordLabel}）`;
  $('login-hint').textContent = `※ ${h.idLabel} と ${h.passwordLabel} でログインしてください。`;
}

$('emp-login-btn').addEventListener('click', async () => {
  const loginId = $('loginId').value.trim();
  const password = $('emppw').value;
  if (!loginId || !password) return toast('ログインIDとパスワードを入力してください', true);
  try {
    employee = await api(`/api/t/${slug}/employee/login`, { method: 'POST', body: JSON.stringify({ loginId, password }) });
    $('emp-login').classList.add('hidden');
    await startReserve();
  } catch (e) { toast(e.message, true); }
});

$('emp-logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await api(`/api/t/${slug}/employee/logout`, { method: 'POST' });
  location.reload();
});

async function startReserve() {
  $('reserve-ui').classList.remove('hidden');

  if (employee) {
    effectiveSubsidy = employee.subsidy || 0;
    $('emp-logout').classList.remove('hidden');
    $('emp-name').textContent = `${employee.name}${employee.employee_code ? '（' + employee.employee_code + '）' : ''}`;
    $('emp-dept').textContent = employee.department ? ` / ${employee.department}` : '';
    $('emp-subsidy').textContent = yen(effectiveSubsidy);
    // 受診者情報を従業員マスタから初期表示（編集可）
    $('name').value = employee.name || '';
    $('kana').value = employee.kana || '';
    $('birthday').value = employee.birthday || '';
    $('gender').value = employee.gender || '';
    $('phone').value = employee.phone || '';
    $('email').value = employee.email || '';
  } else {
    effectiveSubsidy = tenant.subsidy || 0;
    $('emp-banner').classList.add('hidden');
  }

  $('date').min = todayStr();
  $('date').value = todayStr();

  [courses, options] = await Promise.all([
    api(`/api/t/${slug}/courses`),
    api(`/api/t/${slug}/options`),
  ]);
  $('course').innerHTML = '<option value="">コースを選択</option>' +
    courses.map((c) => `<option value="${c.id}">${esc(c.name)}（${yen(c.price)}）</option>`).join('');

  renderOptions();
  recalcCost();
  await loadSlots();

  ['course', 'date'].forEach((id) => $(id).addEventListener('change', loadSlots));
  ['birthday', 'gender'].forEach((id) => $(id).addEventListener('change', () => { renderOptions(); recalcCost(); }));
  $('course').addEventListener('change', recalcCost);
}

async function loadSlots() {
  const date = $('date').value;
  const courseId = $('course').value;
  if (!date) { slots = []; return renderSlots(); }
  const params = new URLSearchParams({ date });
  if (courseId) params.set('course_id', courseId);
  try { slots = await api(`/api/t/${slug}/slots?` + params); } catch (e) { return toast(e.message, true); }
  renderSlots();
}

function renderSlots() {
  selectedSlot = null;
  updateSubmit();
  if (!slots.length) { $('slots').innerHTML = ''; $('slots-empty').classList.remove('hidden'); return; }
  $('slots-empty').classList.add('hidden');
  $('slots').innerHTML = slots.map((s) => {
    const full = s.remaining <= 0;
    return `<div class="slot ${full ? 'full' : ''}" data-id="${s.id}">
      <div class="time">${esc(s.start_time)}</div>
      <div class="course">${esc(s.course)}</div>
      <div class="remain">${full ? '<span class="badge full">満員</span>' : `<span class="badge avail">残り ${s.remaining} 名</span>`}</div>
    </div>`;
  }).join('');
  $('slots').querySelectorAll('.slot:not(.full)').forEach((el) =>
    el.addEventListener('click', () => selectSlot(Number(el.dataset.id), el)));
}

function selectSlot(id, el) {
  $('slots').querySelectorAll('.slot').forEach((s) => s.classList.remove('selected'));
  el.classList.add('selected');
  selectedSlot = slots.find((x) => x.id === id);
  if (!$('course').value) { $('course').value = selectedSlot.course_id; }
  recalcCost();
  updateSubmit();
}

function calcAge() {
  const bd = $('birthday').value;
  if (!bd) return null;
  const ref = $('date').value ? new Date($('date').value) : new Date();
  const b = new Date(bd);
  let age = ref.getFullYear() - b.getFullYear();
  const m = ref.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < b.getDate())) age--;
  return age;
}

function eligible(o) {
  const gender = $('gender').value;
  const age = calcAge();
  if (o.cond_gender && o.cond_gender !== 'any' && o.cond_gender !== gender) return false;
  if (o.cond_min_age != null && (age == null || age < o.cond_min_age)) return false;
  if (o.cond_max_age != null && (age == null || age > o.cond_max_age)) return false;
  return true;
}

function renderOptions() {
  if (!options.length) { $('options-empty').classList.remove('hidden'); $('options').innerHTML = ''; return; }
  $('options-empty').classList.add('hidden');
  const checkedIds = new Set([...document.querySelectorAll('input[data-opt]:checked')].map((c) => Number(c.dataset.opt)));
  $('options').innerHTML = options.map((o) => {
    const ok = eligible(o);
    const checked = ok && checkedIds.has(o.id) ? 'checked' : '';
    return `<label class="option-row ${ok ? '' : 'disabled'}">
      <input type="checkbox" data-opt="${o.id}" data-price="${o.price}" ${ok ? '' : 'disabled'} ${checked} />
      <span class="meta">
        <strong>${esc(o.name)}</strong>
        <div class="cond">条件: ${esc(o.conditionLabel)}${ok ? '' : ' ／ 対象外のため選択できません'}</div>
      </span>
      <span class="price">${yen(o.price)}</span>
    </label>`;
  }).join('');
  $('options').querySelectorAll('input[data-opt]').forEach((c) => c.addEventListener('change', recalcCost));
}

function recalcCost() {
  const course = courses.find((c) => String(c.id) === $('course').value);
  const coursePrice = course ? course.price : 0;
  const optTotal = [...document.querySelectorAll('input[data-opt]:checked')]
    .reduce((s, c) => s + Number(c.dataset.price), 0);
  const self = Math.max(0, coursePrice + optTotal - effectiveSubsidy);
  $('c-course').textContent = course ? yen(coursePrice) : '—';
  $('c-option').textContent = yen(optTotal);
  $('c-subsidy').textContent = '-' + yen(effectiveSubsidy);
  $('c-self').textContent = course ? yen(self) : '—';
  updateSubmit();
}

function updateSubmit() {
  $('submit-btn').disabled = !(selectedSlot && $('course').value);
}

$('submit-btn').addEventListener('click', async () => {
  if (!selectedSlot) return toast('時間枠を選択してください', true);
  const option_ids = [...document.querySelectorAll('input[data-opt]:checked')].map((c) => Number(c.dataset.opt));
  const payload = {
    slot_id: selectedSlot.id,
    name: $('name').value.trim(), kana: $('kana').value.trim(),
    birthday: $('birthday').value || null, gender: $('gender').value || null,
    phone: $('phone').value.trim(), email: $('email').value.trim() || null,
    note: $('note').value.trim() || null, option_ids,
  };
  if (!payload.name || !payload.kana || !payload.phone) return toast('氏名・フリガナ・電話番号は必須です', true);
  try {
    $('submit-btn').disabled = true;
    const result = await api(`/api/t/${slug}/reservations`, { method: 'POST', body: JSON.stringify(payload) });
    showDone(result);
  } catch (e) {
    toast(e.message, true);
    $('submit-btn').disabled = false;
    await loadSlots();
  }
});

function showDone(result) {
  const r = result.reservation;
  $('reserve-ui').classList.add('hidden');
  $('done').classList.remove('hidden');
  $('done-summary').textContent = `${r.slot_date} ${r.start_time} / ${r.course} ／ 自己負担額 ${yen(r.self_pay)}`;
  $('done-mail').textContent = r.email
    ? `予約完了メールを ${r.email} 宛に送信しました（デモ環境ではサーバーログに出力）。`
    : '';
  $('cal-google').href = result.links.google;
  $('cal-outlook').href = result.links.outlook;
  $('cal-ics').href = result.links.ics;
  $('cal-ics').setAttribute('download', `kenshin-${r.id}.ics`);

  if (result.useQuestionnaire) {
    $('done-q').classList.remove('hidden');
    $('go-questionnaire').href = `/t/${slug}/questionnaire?reservation_id=${r.id}`;
  }
  window.scrollTo(0, 0);
}

document.getElementById('again').addEventListener('click', (e) => { e.preventDefault(); location.reload(); });
