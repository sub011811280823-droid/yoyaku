'use strict';

(async function guard() {
  try {
    const me = await api('/api/auth/me');
    if (!me || me.role !== 'super') return (location.href = '/super/login');
  } catch (_) { location.href = '/super/login'; }
  load();
})();

document.getElementById('logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/auth/logout', { method: 'POST' });
  location.href = '/super/login';
});

const tbody = document.getElementById('tenant-tbody');

async function load() {
  let list;
  try { list = await api('/api/super/tenants'); } catch (e) { return toast(e.message, true); }
  tbody.innerHTML = list.map((t) => {
    const admins = t.admins.map((a) => esc(a.username)).join(', ') || '-';
    const url = `/t/${esc(t.slug)}`;
    return `
      <tr>
        <td>${t.id}</td>
        <td><strong>${esc(t.name)}</strong><br><code class="inline">${esc(t.slug)}</code></td>
        <td>${admins}</td>
        <td>${t.reservationCount}</td>
        <td><input type="number" min="0" value="${t.subsidy}" data-sub="${t.id}" style="width:90px;padding:4px 6px;" /></td>
        <td><input type="checkbox" data-res="${t.id}" ${t.use_reservation ? 'checked' : ''} style="width:auto;" /></td>
        <td><input type="checkbox" data-q="${t.id}" ${t.use_questionnaire ? 'checked' : ''} style="width:auto;" /></td>
        <td><a href="${url}" target="_blank">${url}</a></td>
        <td style="white-space:nowrap;">
          <button class="small" data-save="${t.id}">保存</button>
          <button class="small secondary" data-pw="${t.id}" data-admin="${esc(t.admins[0]?.username || '')}">PW再設定</button>
          <button class="small danger" data-del="${t.id}">削除</button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('button[data-save]').forEach((b) => b.addEventListener('click', () => saveTenant(Number(b.dataset.save))));
  tbody.querySelectorAll('button[data-del]').forEach((b) => b.addEventListener('click', () => delTenant(Number(b.dataset.del))));
  tbody.querySelectorAll('button[data-pw]').forEach((b) => b.addEventListener('click', () => resetPw(Number(b.dataset.pw), b.dataset.admin)));
}

async function saveTenant(id) {
  const subsidy = Number(tbody.querySelector(`input[data-sub="${id}"]`).value);
  const use_reservation = tbody.querySelector(`input[data-res="${id}"]`).checked;
  const use_questionnaire = tbody.querySelector(`input[data-q="${id}"]`).checked;
  try {
    await api('/api/super/tenants/' + id, { method: 'PATCH', body: JSON.stringify({ subsidy, use_reservation, use_questionnaire }) });
    toast('保存しました');
    load();
  } catch (e) { toast(e.message, true); }
}

async function delTenant(id) {
  if (!confirm('この企業と関連データ（予約・問診・設定）をすべて削除します。よろしいですか？')) return;
  try { await api('/api/super/tenants/' + id, { method: 'DELETE' }); toast('削除しました'); load(); }
  catch (e) { toast(e.message, true); }
}

async function resetPw(id, username) {
  const u = prompt('パスワードを再設定する管理者ID', username);
  if (!u) return;
  const np = prompt('新しいパスワード');
  if (!np) return;
  try { await api(`/api/super/tenants/${id}/reset-password`, { method: 'POST', body: JSON.stringify({ username: u, newPassword: np }) }); toast('パスワードを再設定しました'); }
  catch (e) { toast(e.message, true); }
}

document.getElementById('tenant-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    slug: document.getElementById('t-slug').value.trim(),
    name: document.getElementById('t-name').value.trim(),
    adminUsername: document.getElementById('t-admin').value.trim(),
    adminPassword: document.getElementById('t-pw').value,
  };
  try {
    await api('/api/super/tenants', { method: 'POST', body: JSON.stringify(payload) });
    toast('企業を追加しました');
    e.target.reset();
    load();
  } catch (err) { toast(err.message, true); }
});
