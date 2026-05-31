'use strict';

const isSuper = location.pathname.startsWith('/super');
const scope = isSuper ? 'super' : 'admin';
const dest = isSuper ? '/super' : '/admin';

document.getElementById('login-title').textContent = isSuper ? 'スーパー管理者ログイン' : '企業管理者ログイン';
document.getElementById('login-sub').textContent = isSuper
  ? 'システム全体を管理します。'
  : '自社の予約枠・問診・予約データを管理します。';

// 既にログイン済みなら遷移
(async function () {
  try {
    const me = await api('/api/auth/me');
    if (me && me.role === scope) location.href = dest;
  } catch (_) {}
})();

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('username').value.trim(),
        password: document.getElementById('password').value,
        scope,
      }),
    });
    location.href = dest;
  } catch (err) {
    toast(err.message, true);
  }
});
