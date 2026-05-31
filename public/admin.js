'use strict';

const $ = (id) => document.getElementById(id);
let me = null;
let coursesCache = [];

// ---- 認証ガード ----
(async function guard() {
  try {
    me = await api('/api/auth/me');
    if (!me || me.role !== 'admin') return (location.href = '/admin/login');
  } catch { return (location.href = '/admin/login'); }
  const slug = me.tenant.slug;
  $('tenant-name').textContent = `${me.tenant.name} 管理`;
  $('public-link').href = `/t/${slug}`;
  $('link-reserve').href = $('link-reserve').textContent = `${location.origin}/t/${slug}`;
  $('link-q').href = $('link-q').textContent = `${location.origin}/t/${slug}/questionnaire`;
  initTabs();
  loadReservations();
})();

$('logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/auth/logout', { method: 'POST' });
  location.href = '/admin/login';
});

// ---- タブ ----
const LOADERS = {
  reservations: loadReservations, slots: loadSlots, courses: loadCourses,
  options: loadOptions, employees: loadEmployeesTab, questions: loadQuestions,
  responses: loadResponses, settings: loadSettings,
};
function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      document.querySelectorAll('main > section').forEach((s) => s.classList.add('hidden'));
      $('tab-' + name).classList.remove('hidden');
      LOADERS[name]();
    });
  });
}

// ============ 予約管理 ============
async function loadReservations() {
  const params = new URLSearchParams();
  if ($('f-date').value) params.set('date', $('f-date').value);
  if ($('f-status').value) params.set('status', $('f-status').value);
  let list;
  try { list = await api('/api/admin/reservations?' + params); } catch (e) { return toast(e.message, true); }
  const confirmed = list.filter((r) => r.status === 'confirmed').length;
  $('res-summary').innerHTML = `
    <div class="stat"><div class="n">${list.length}</div><div class="l">合計</div></div>
    <div class="stat"><div class="n">${confirmed}</div><div class="l">確定</div></div>
    <div class="stat"><div class="n">${list.length - confirmed}</div><div class="l">キャンセル</div></div>`;
  if (!list.length) { $('res-tbody').innerHTML = ''; $('res-empty').classList.remove('hidden'); return; }
  $('res-empty').classList.add('hidden');
  $('res-tbody').innerHTML = list.map((r) => {
    const conf = r.status === 'confirmed';
    const opts = (r.options || []).map((o) => esc(o.name)).join(', ') || '-';
    const badge = conf ? '<span class="badge ok">確定</span>' : '<span class="badge cancelled">キャンセル</span>';
    const toggle = conf
      ? `<button class="small secondary" data-act="cancel" data-id="${r.id}">キャンセル</button>`
      : `<button class="small" data-act="confirm" data-id="${r.id}">確定に戻す</button>`;
    return `<tr>
      <td>${esc(r.slot_date)}</td><td>${esc(r.start_time)}</td><td>${esc(r.course)}</td>
      <td>${esc(r.name)}<br><span class="muted" style="font-size:.78rem;">${esc(r.kana)}</span></td>
      <td>${esc(r.gender || '-')}</td>
      <td style="font-size:.82rem;">${opts}</td>
      <td>${yen(r.self_pay)}</td>
      <td style="font-size:.78rem;">${esc(r.phone)}<br>${esc(r.email || '')}</td>
      <td>${badge}</td>
      <td style="white-space:nowrap;">${toggle} <button class="small danger" data-act="delete" data-id="${r.id}">削除</button></td>
    </tr>`;
  }).join('');
  $('res-tbody').querySelectorAll('button[data-act]').forEach((b) =>
    b.addEventListener('click', () => resAction(b.dataset.act, Number(b.dataset.id))));
}
async function resAction(act, id) {
  try {
    if (act === 'delete') { if (!confirm('この予約を削除しますか？')) return; await api('/api/admin/reservations/' + id, { method: 'DELETE' }); }
    else await api('/api/admin/reservations/' + id, { method: 'PATCH', body: JSON.stringify({ status: act === 'cancel' ? 'cancelled' : 'confirmed' }) });
    toast('更新しました'); loadReservations();
  } catch (e) { toast(e.message, true); }
}
$('f-date').addEventListener('change', loadReservations);
$('f-status').addEventListener('change', loadReservations);
$('f-clear').addEventListener('click', () => { $('f-date').value = ''; $('f-status').value = ''; loadReservations(); });

// ============ コース ============
async function loadCourses() {
  try { coursesCache = await api('/api/admin/courses'); } catch (e) { return toast(e.message, true); }
  $('course-tbody').innerHTML = coursesCache.map((c) => `
    <tr>
      <td><input type="text" value="${esc(c.name)}" data-cname="${c.id}" /></td>
      <td><input type="number" min="0" value="${c.price}" data-cprice="${c.id}" style="width:110px;" /></td>
      <td>${c.active ? '<span class="badge ok">有効</span>' : '<span class="badge cancelled">無効</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="small" data-csave="${c.id}">保存</button>
        <button class="small secondary" data-ctoggle="${c.id}" data-active="${c.active}">${c.active ? '無効化' : '有効化'}</button>
        <button class="small danger" data-cdel="${c.id}">削除</button>
      </td>
    </tr>`).join('');
  $('course-tbody').querySelectorAll('button[data-csave]').forEach((b) => b.addEventListener('click', () => saveCourse(Number(b.dataset.csave))));
  $('course-tbody').querySelectorAll('button[data-ctoggle]').forEach((b) => b.addEventListener('click', () => toggleCourse(Number(b.dataset.ctoggle), b.dataset.active === '1' ? 0 : 1)));
  $('course-tbody').querySelectorAll('button[data-cdel]').forEach((b) => b.addEventListener('click', () => delCourse(Number(b.dataset.cdel))));
}
async function saveCourse(id) {
  const name = $('course-tbody').querySelector(`input[data-cname="${id}"]`).value.trim();
  const price = Number($('course-tbody').querySelector(`input[data-cprice="${id}"]`).value);
  try { await api('/api/admin/courses/' + id, { method: 'PATCH', body: JSON.stringify({ name, price }) }); toast('保存しました'); loadCourses(); }
  catch (e) { toast(e.message, true); }
}
async function toggleCourse(id, active) { try { await api('/api/admin/courses/' + id, { method: 'PATCH', body: JSON.stringify({ active }) }); loadCourses(); } catch (e) { toast(e.message, true); } }
async function delCourse(id) { if (!confirm('このコースを削除しますか？')) return; try { await api('/api/admin/courses/' + id, { method: 'DELETE' }); toast('削除しました'); loadCourses(); } catch (e) { toast(e.message, true); } }
$('course-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/api/admin/courses', { method: 'POST', body: JSON.stringify({ name: $('co-name').value.trim(), price: Number($('co-price').value) }) }); toast('追加しました'); e.target.reset(); $('co-price').value = 0; loadCourses(); }
  catch (err) { toast(err.message, true); }
});

// ============ 予約枠 ============
async function ensureCourses() { if (!coursesCache.length) coursesCache = await api('/api/admin/courses'); return coursesCache; }
async function loadSlots() {
  await ensureCourses();
  $('s-course').innerHTML = coursesCache.filter((c) => c.active).map((c) => `<option value="${c.id}">${esc(c.name)}（${yen(c.price)}）</option>`).join('');
  const params = new URLSearchParams();
  if ($('slot-fdate').value) params.set('date', $('slot-fdate').value);
  let list;
  try { list = await api('/api/admin/slots?' + params); } catch (e) { return toast(e.message, true); }
  if (!list.length) { $('slot-tbody').innerHTML = ''; $('slot-empty').classList.remove('hidden'); return; }
  $('slot-empty').classList.add('hidden');
  $('slot-tbody').innerHTML = list.map((s) => {
    const full = s.remaining <= 0;
    return `<tr>
      <td>${esc(s.slot_date)}</td><td>${esc(s.start_time)}</td><td>${esc(s.course)}</td>
      <td><input type="number" min="1" value="${s.capacity}" data-cap="${s.id}" style="width:70px;" /></td>
      <td>${s.booked}</td>
      <td>${full ? '<span class="badge full">満員</span>' : `<span class="badge avail">${s.remaining}</span>`}</td>
      <td style="white-space:nowrap;"><button class="small" data-ssave="${s.id}">定員保存</button> <button class="small danger" data-sdel="${s.id}">削除</button></td>
    </tr>`;
  }).join('');
  $('slot-tbody').querySelectorAll('button[data-ssave]').forEach((b) => b.addEventListener('click', () => saveSlot(Number(b.dataset.ssave))));
  $('slot-tbody').querySelectorAll('button[data-sdel]').forEach((b) => b.addEventListener('click', () => delSlot(Number(b.dataset.sdel))));
}
async function saveSlot(id) {
  const cap = Number($('slot-tbody').querySelector(`input[data-cap="${id}"]`).value);
  try { await api('/api/admin/slots/' + id, { method: 'PATCH', body: JSON.stringify({ capacity: cap }) }); toast('保存しました'); loadSlots(); } catch (e) { toast(e.message, true); }
}
async function delSlot(id) { if (!confirm('この枠を削除しますか？')) return; try { await api('/api/admin/slots/' + id, { method: 'DELETE' }); toast('削除しました'); loadSlots(); } catch (e) { toast(e.message, true); } }
$('bulk').addEventListener('change', () => $('bulk-opts').classList.toggle('hidden', !$('bulk').checked));
function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function toT(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
$('slot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const slot_date = $('s-date').value, start = $('s-time').value, course_id = Number($('s-course').value), capacity = Number($('s-cap').value);
  if (!slot_date || !start || !course_id) return toast('日付・時間・コースを入力してください', true);
  let times = [start];
  if ($('bulk').checked) {
    const end = $('s-end').value, interval = Number($('s-int').value);
    if (!end || !interval) return toast('終了時間と間隔を指定してください', true);
    if (toMin(end) <= toMin(start)) return toast('終了時間は開始時間より後にしてください', true);
    times = []; for (let m = toMin(start); m <= toMin(end); m += interval) times.push(toT(m));
  }
  let ok = 0, skip = 0;
  for (const t of times) {
    try { await api('/api/admin/slots', { method: 'POST', body: JSON.stringify({ slot_date, start_time: t, course_id, capacity }) }); ok++; }
    catch { skip++; }
  }
  toast(`${ok}件追加${skip ? `（${skip}件スキップ）` : ''}`); loadSlots();
});
$('slot-fdate').addEventListener('change', loadSlots);
$('slot-fclear').addEventListener('click', () => { $('slot-fdate').value = ''; loadSlots(); });

// ============ オプション ============
let optionsCache = [];
function optCondText(o) {
  const p = [];
  if (o.cond_gender !== 'any') p.push(o.cond_gender + '限定');
  if (o.cond_min_age != null && o.cond_max_age != null) p.push(`${o.cond_min_age}〜${o.cond_max_age}歳`);
  else if (o.cond_min_age != null) p.push(`${o.cond_min_age}歳以上`);
  else if (o.cond_max_age != null) p.push(`${o.cond_max_age}歳以下`);
  return p.join(' / ') || '条件なし';
}
async function loadOptions() {
  try { optionsCache = await api('/api/admin/options'); } catch (e) { return toast(e.message, true); }
  $('option-tbody').innerHTML = optionsCache.map((o) => `
    <tr>
      <td>${esc(o.name)}</td><td>${yen(o.price)}</td><td>${esc(optCondText(o))}</td>
      <td>${o.active ? '<span class="badge ok">有効</span>' : '<span class="badge cancelled">無効</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="small" data-oedit="${o.id}">編集</button>
        <button class="small secondary" data-otoggle="${o.id}" data-active="${o.active}">${o.active ? '無効化' : '有効化'}</button>
        <button class="small danger" data-odel="${o.id}">削除</button>
      </td>
    </tr>`).join('');
  $('option-tbody').querySelectorAll('button[data-oedit]').forEach((b) => b.addEventListener('click', () => editOption(Number(b.dataset.oedit))));
  $('option-tbody').querySelectorAll('button[data-otoggle]').forEach((b) => b.addEventListener('click', () => toggleOption(Number(b.dataset.otoggle), b.dataset.active === '1' ? 0 : 1)));
  $('option-tbody').querySelectorAll('button[data-odel]').forEach((b) => b.addEventListener('click', () => delOption(Number(b.dataset.odel))));
}
function fillOptForm(o) {
  $('op-id').value = o ? o.id : '';
  $('op-name').value = o ? o.name : '';
  $('op-price').value = o ? o.price : 0;
  $('op-gender').value = o ? o.cond_gender : 'any';
  $('op-min').value = o && o.cond_min_age != null ? o.cond_min_age : '';
  $('op-max').value = o && o.cond_max_age != null ? o.cond_max_age : '';
  $('op-form-title').textContent = o ? `オプションを編集（${o.name}）` : 'オプション検査を追加';
  $('op-submit').textContent = o ? '更新' : '＋ 追加';
  $('op-cancel').classList.toggle('hidden', !o);
}
function editOption(id) { const o = optionsCache.find((x) => x.id === id); if (o) { fillOptForm(o); window.scrollTo(0, 0); } }
$('op-cancel').addEventListener('click', () => fillOptForm(null));
async function toggleOption(id, active) { try { await api('/api/admin/options/' + id, { method: 'PATCH', body: JSON.stringify({ active }) }); loadOptions(); } catch (e) { toast(e.message, true); } }
async function delOption(id) { if (!confirm('このオプションを削除しますか？')) return; try { await api('/api/admin/options/' + id, { method: 'DELETE' }); toast('削除しました'); loadOptions(); } catch (e) { toast(e.message, true); } }
$('option-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('op-id').value;
  const payload = {
    name: $('op-name').value.trim(), price: Number($('op-price').value), cond_gender: $('op-gender').value,
    cond_min_age: $('op-min').value === '' ? null : Number($('op-min').value),
    cond_max_age: $('op-max').value === '' ? null : Number($('op-max').value),
  };
  try {
    if (id) await api('/api/admin/options/' + id, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/api/admin/options', { method: 'POST', body: JSON.stringify(payload) });
    toast(id ? '更新しました' : '追加しました');
    fillOptForm(null); $('op-price').value = 0;
    loadOptions();
  } catch (err) { toast(err.message, true); }
});

// ============ 従業員マスタ ============
function empFilterParams() {
  const p = new URLSearchParams();
  if ($('e-q').value.trim()) p.set('q', $('e-q').value.trim());
  if ($('e-dep').value) p.set('department', $('e-dep').value);
  if ($('e-active').value) p.set('active', $('e-active').value);
  if ($('e-min').value) p.set('minSubsidy', $('e-min').value);
  if ($('e-max').value) p.set('maxSubsidy', $('e-max').value);
  return p;
}
function empFilterObj() {
  const o = {};
  if ($('e-q').value.trim()) o.q = $('e-q').value.trim();
  if ($('e-dep').value) o.department = $('e-dep').value;
  if ($('e-active').value) o.active = $('e-active').value;
  if ($('e-min').value) o.minSubsidy = $('e-min').value;
  if ($('e-max').value) o.maxSubsidy = $('e-max').value;
  return o;
}
async function loadDepartments() {
  try {
    const deps = await api('/api/admin/employees/departments');
    const cur = $('e-dep').value;
    $('e-dep').innerHTML = '<option value="">すべて</option>' + deps.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
    $('e-dep').value = cur;
  } catch {}
}
async function loadEmployeesTab() { await loadDepartments(); await loadEmployees(); }
async function loadEmployees() {
  let list;
  try { list = await api('/api/admin/employees?' + empFilterParams()); } catch (e) { return toast(e.message, true); }
  $('e-count').textContent = `（${list.length}名）`;
  if (!list.length) { $('employee-tbody').innerHTML = ''; $('employee-empty').classList.remove('hidden'); return; }
  $('employee-empty').classList.add('hidden');
  $('employee-tbody').innerHTML = list.map((e) => `
    <tr>
      <td>${esc(e.employee_code || '-')}</td>
      <td>${esc(e.name)}<br><span class="muted" style="font-size:.78rem;">${esc(e.kana || '')}</span></td>
      <td>${esc(e.department || '-')}</td>
      <td>${esc(e.birthday || '-')}</td>
      <td>${esc(e.gender || '-')}</td>
      <td style="font-size:.8rem;">${esc(e.email || '-')}</td>
      <td>${e.subsidy == null ? '<span class="muted">企業既定</span>' : yen(e.subsidy)}</td>
      <td>${e.active ? '<span class="badge ok">有効</span>' : '<span class="badge cancelled">無効</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="small" data-eedit="${e.id}">編集</button>
        <button class="small secondary" data-etoggle="${e.id}" data-active="${e.active}">${e.active ? '無効化' : '有効化'}</button>
        <button class="small danger" data-edel="${e.id}">削除</button>
      </td>
    </tr>`).join('');
  window._empList = list;
  $('employee-tbody').querySelectorAll('button[data-eedit]').forEach((b) => b.addEventListener('click', () => editEmployee(Number(b.dataset.eedit))));
  $('employee-tbody').querySelectorAll('button[data-etoggle]').forEach((b) => b.addEventListener('click', () => toggleEmployee(Number(b.dataset.etoggle), b.dataset.active === '1' ? 0 : 1)));
  $('employee-tbody').querySelectorAll('button[data-edel]').forEach((b) => b.addEventListener('click', () => delEmployee(Number(b.dataset.edel))));
}
function fillEmpForm(e) {
  $('e-id').value = e ? e.id : '';
  $('e-code').value = e ? (e.employee_code || '') : '';
  $('e-name').value = e ? e.name : '';
  $('e-kana').value = e ? (e.kana || '') : '';
  $('e-dept').value = e ? (e.department || '') : '';
  $('e-email').value = e ? (e.email || '') : '';
  $('e-birthday').value = e ? (e.birthday || '') : '';
  $('e-gender').value = e ? (e.gender || '') : '';
  $('e-phone').value = e ? (e.phone || '') : '';
  $('e-subsidy').value = e && e.subsidy != null ? e.subsidy : '';
  $('e-password').value = e ? (e.password || '') : '';
  $('e-form-title').textContent = e ? `従業員を編集（ID ${e.id}）` : '従業員を追加';
  $('e-submit').textContent = e ? '更新' : '追加';
  $('e-cancel').classList.toggle('hidden', !e);
}
function editEmployee(id) {
  const e = (window._empList || []).find((x) => x.id === id);
  if (e) { fillEmpForm(e); window.scrollTo(0, 0); }
}
$('e-cancel').addEventListener('click', () => fillEmpForm(null));
async function toggleEmployee(id, active) { try { await api('/api/admin/employees/' + id, { method: 'PATCH', body: JSON.stringify({ active }) }); loadEmployees(); } catch (e) { toast(e.message, true); } }
async function delEmployee(id) { if (!confirm('この従業員を削除しますか？')) return; try { await api('/api/admin/employees/' + id, { method: 'DELETE' }); toast('削除しました'); loadEmployeesTab(); } catch (e) { toast(e.message, true); } }
$('employee-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('e-id').value;
  const payload = {
    employee_code: $('e-code').value.trim(), name: $('e-name').value.trim(), kana: $('e-kana').value.trim(),
    department: $('e-dept').value.trim(), email: $('e-email').value.trim(), birthday: $('e-birthday').value,
    gender: $('e-gender').value, phone: $('e-phone').value.trim(),
    subsidy: $('e-subsidy').value === '' ? null : Number($('e-subsidy').value),
    password: $('e-password').value,
  };
  try {
    if (id) await api('/api/admin/employees/' + id, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/api/admin/employees', { method: 'POST', body: JSON.stringify(payload) });
    toast(id ? '更新しました' : '追加しました');
    fillEmpForm(null);
    loadEmployeesTab();
  } catch (err) { toast(err.message, true); }
});
$('e-search').addEventListener('click', loadEmployees);
$('e-clear').addEventListener('click', () => { ['e-q', 'e-dep', 'e-active', 'e-min', 'e-max'].forEach((i) => $(i).value = ''); loadEmployees(); });
$('e-import').addEventListener('click', async () => {
  const f = $('e-file').files[0];
  if (!f) return toast('ファイルを選択してください', true);
  const fd = new FormData();
  fd.append('file', f);
  try {
    const res = await fetch('/api/admin/employees/import', { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'インポート失敗');
    toast(`インポート完了: 追加${data.inserted} / 更新${data.updated}${data.skipped ? ` / スキップ${data.skipped}` : ''}`);
    $('e-file').value = '';
    loadEmployeesTab();
  } catch (e) { toast(e.message, true); }
});
$('e-bulk-apply').addEventListener('click', async () => {
  const v = $('e-bulk').value;
  if (v === '') return toast('一括設定する補助額を入力してください', true);
  if (!confirm('現在の検索条件に合致する従業員の補助額を一括で置き換えます。よろしいですか？')) return;
  try {
    const r = await api('/api/admin/employees/bulk-subsidy', { method: 'POST', body: JSON.stringify({ subsidy: Number(v), filter: empFilterObj() }) });
    toast(`${r.updated}名の補助額を更新しました`);
    $('e-bulk').value = '';
    loadEmployees();
  } catch (e) { toast(e.message, true); }
});

// ============ 問診設定 ============
$('q-type').addEventListener('change', () => {
  $('q-choices-wrap').classList.toggle('hidden', !['radio', 'checkbox', 'select'].includes($('q-type').value));
});
const TYPE_JA = { text: '1行テキスト', textarea: '複数行', number: '数値', radio: '単一選択', checkbox: '複数選択', select: 'プルダウン' };
let questionsCache = [];
async function loadQuestions() {
  try { questionsCache = await api('/api/admin/questions'); } catch (e) { return toast(e.message, true); }
  $('question-tbody').innerHTML = questionsCache.map((q) => {
    const choices = q.choices ? JSON.parse(q.choices).join(' / ') : '-';
    return `<tr>
      <td><input type="number" value="${q.sort_order}" data-qorder="${q.id}" style="width:56px;" /></td>
      <td>${esc(q.label)}</td><td><span class="badge neutral">${TYPE_JA[q.type] || q.type}</span></td><td style="font-size:.82rem;">${esc(choices)}</td>
      <td>${q.required ? '必須' : '任意'}</td>
      <td>${q.active ? '<span class="badge ok">有効</span>' : '<span class="badge cancelled">無効</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="small" data-qedit="${q.id}">編集</button>
        <button class="small secondary" data-qorder-save="${q.id}">順序保存</button>
        <button class="small secondary" data-qtoggle="${q.id}" data-active="${q.active}">${q.active ? '無効化' : '有効化'}</button>
        <button class="small danger" data-qdel="${q.id}">削除</button>
      </td>
    </tr>`;
  }).join('');
  $('question-tbody').querySelectorAll('button[data-qedit]').forEach((b) => b.addEventListener('click', () => editQuestion(Number(b.dataset.qedit))));
  $('question-tbody').querySelectorAll('button[data-qorder-save]').forEach((b) => b.addEventListener('click', () => saveQOrder(Number(b.dataset.qorderSave))));
  $('question-tbody').querySelectorAll('button[data-qtoggle]').forEach((b) => b.addEventListener('click', () => toggleQ(Number(b.dataset.qtoggle), b.dataset.active === '1' ? 0 : 1)));
  $('question-tbody').querySelectorAll('button[data-qdel]').forEach((b) => b.addEventListener('click', () => delQ(Number(b.dataset.qdel))));
}
function fillQForm(q) {
  $('q-id').value = q ? q.id : '';
  $('q-label').value = q ? q.label : '';
  $('q-type').value = q ? q.type : 'text';
  $('q-required').checked = q ? !!q.required : false;
  $('q-choices').value = q && q.choices ? JSON.parse(q.choices).join('\n') : '';
  $('q-choices-wrap').classList.toggle('hidden', !['radio', 'checkbox', 'select'].includes($('q-type').value));
  $('q-form-title').textContent = q ? `問診項目を編集` : '問診項目を追加';
  $('q-submit').textContent = q ? '更新' : '＋ 項目を追加';
  $('q-cancel').classList.toggle('hidden', !q);
}
function editQuestion(id) { const q = questionsCache.find((x) => x.id === id); if (q) { fillQForm(q); window.scrollTo(0, 0); } }
$('q-cancel').addEventListener('click', () => fillQForm(null));
async function saveQOrder(id) { const v = Number($('question-tbody').querySelector(`input[data-qorder="${id}"]`).value); try { await api('/api/admin/questions/' + id, { method: 'PATCH', body: JSON.stringify({ sort_order: v }) }); toast('保存しました'); loadQuestions(); } catch (e) { toast(e.message, true); } }
async function toggleQ(id, active) { try { await api('/api/admin/questions/' + id, { method: 'PATCH', body: JSON.stringify({ active }) }); loadQuestions(); } catch (e) { toast(e.message, true); } }
async function delQ(id) { if (!confirm('この問診項目を削除しますか？')) return; try { await api('/api/admin/questions/' + id, { method: 'DELETE' }); toast('削除しました'); loadQuestions(); } catch (e) { toast(e.message, true); } }
$('question-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('q-id').value;
  const type = $('q-type').value;
  const payload = { label: $('q-label').value.trim(), type, required: $('q-required').checked, choices: $('q-choices').value };
  if (['radio', 'checkbox', 'select'].includes(type) && !$('q-choices').value.trim()) return toast('選択肢を入力してください', true);
  try {
    if (id) await api('/api/admin/questions/' + id, { method: 'PATCH', body: JSON.stringify(payload) });
    else await api('/api/admin/questions', { method: 'POST', body: JSON.stringify(payload) });
    toast(id ? '更新しました' : '追加しました');
    fillQForm(null);
    loadQuestions();
  } catch (err) { toast(err.message, true); }
});

// ============ 問診回答 ============
async function loadResponses() {
  let list;
  try { list = await api('/api/admin/responses'); } catch (e) { return toast(e.message, true); }
  if (!list.length) { $('responses').innerHTML = ''; $('responses-empty').classList.remove('hidden'); return; }
  $('responses-empty').classList.add('hidden');
  $('responses').innerHTML = list.map((r) => {
    const rows = r.answers.map((a) => {
      let v = a.value;
      try { const p = JSON.parse(v); if (Array.isArray(p)) v = p.join('、'); } catch {}
      return `<tr><td style="width:40%;">${esc(a.label)}</td><td>${esc(v)}</td></tr>`;
    }).join('');
    return `<div class="card" style="background:#fafcff;">
      <strong>${esc(r.respondent_name || '（予約紐付けなし）')}</strong>
      <span class="muted" style="font-size:.8rem;"> ／ ${esc(r.created_at)}</span>
      <table style="margin-top:8px;">${rows || '<tr><td>回答なし</td></tr>'}</table>
    </div>`;
  }).join('');
}

// ============ 設定 ============
async function loadSettings() {
  let s;
  try { s = await api('/api/admin/settings'); } catch (e) { return toast(e.message, true); }
  $('set-subsidy').value = s.subsidy;
  $('set-res').checked = !!s.use_reservation;
  $('set-q').checked = !!s.use_questionnaire;
  $('set-loginid').value = s.login_id_field || 'employee_code';
  $('set-pw').value = s.password_field || 'birthday';
  $('set-require').checked = !!s.require_employee_login;
}
$('set-save').addEventListener('click', async () => {
  try {
    await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({
      subsidy: Number($('set-subsidy').value),
      use_reservation: $('set-res').checked,
      use_questionnaire: $('set-q').checked,
      login_id_field: $('set-loginid').value,
      password_field: $('set-pw').value,
      require_employee_login: $('set-require').checked,
    }) });
    toast('設定を保存しました');
  } catch (e) { toast(e.message, true); }
});
