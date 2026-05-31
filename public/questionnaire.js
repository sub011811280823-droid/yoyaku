'use strict';

const slug = getSlug();
const reservationId = new URLSearchParams(location.search).get('reservation_id');
let questions = [];
const $ = (id) => document.getElementById(id);

(async function init() {
  if (!slug) { document.body.innerHTML = '<main><div class="card">URLが不正です。</div></main>'; return; }
  let tenant;
  try { tenant = await api(`/api/t/${slug}/info`); }
  catch { document.body.innerHTML = '<main><div class="card">企業が見つかりません。</div></main>'; return; }
  $('tenant-name').textContent = `${tenant.name} 事前問診`;
  document.title = `${tenant.name} 事前問診`;

  if (!tenant.use_questionnaire) { $('q-off').classList.remove('hidden'); return; }

  try { questions = await api(`/api/t/${slug}/questions`); }
  catch (e) { return toast(e.message, true); }
  $('q-ui').classList.remove('hidden');
  renderForm();
})();

function renderForm() {
  if (!questions.length) {
    $('q-form').innerHTML = '<p class="muted">設定された問診項目がありません。</p>';
    $('q-submit').style.display = 'none';
    return;
  }
  $('q-form').innerHTML = questions.map((q) => {
    const req = q.required ? '<span class="required"></span>' : '';
    let field = '';
    const name = `q_${q.id}`;
    if (q.type === 'text') field = `<input type="text" name="${name}" />`;
    else if (q.type === 'textarea') field = `<textarea name="${name}"></textarea>`;
    else if (q.type === 'number') field = `<input type="number" name="${name}" />`;
    else if (q.type === 'select') field = `<select name="${name}"><option value="">選択してください</option>${q.choices.map((c) => `<option>${esc(c)}</option>`).join('')}</select>`;
    else if (q.type === 'radio') field = q.choices.map((c) => `<label style="font-weight:400;display:flex;gap:6px;align-items:center;"><input type="radio" name="${name}" value="${esc(c)}" style="width:auto;" /> ${esc(c)}</label>`).join('');
    else if (q.type === 'checkbox') field = q.choices.map((c) => `<label style="font-weight:400;display:flex;gap:6px;align-items:center;"><input type="checkbox" name="${name}" value="${esc(c)}" style="width:auto;" /> ${esc(c)}</label>`).join('');
    return `<div class="q-row" style="flex-direction:column;align-items:stretch;">
      <label>${esc(q.label)} ${req}</label>${field}</div>`;
  }).join('');
}

$('q-submit').addEventListener('click', async () => {
  const answers = {};
  for (const q of questions) {
    const name = `q_${q.id}`;
    if (q.type === 'checkbox') {
      answers[q.id] = [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((c) => c.value);
    } else if (q.type === 'radio') {
      const sel = document.querySelector(`input[name="${name}"]:checked`);
      answers[q.id] = sel ? sel.value : '';
    } else {
      const el = document.querySelector(`[name="${name}"]`);
      answers[q.id] = el ? el.value : '';
    }
  }
  try {
    $('q-submit').disabled = true;
    await api(`/api/t/${slug}/questionnaire`, {
      method: 'POST',
      body: JSON.stringify({ reservation_id: reservationId ? Number(reservationId) : null, answers }),
    });
    $('q-ui').classList.add('hidden');
    $('q-done').classList.remove('hidden');
    window.scrollTo(0, 0);
  } catch (e) {
    toast(e.message, true);
    $('q-submit').disabled = false;
  }
});
