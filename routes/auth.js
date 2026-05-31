'use strict';

const express = require('express');
const db = require('../db');
const { verifyPassword } = require('../lib/auth');

const router = express.Router();

// ログイン。scope: 'super' | 'admin'
router.post('/login', (req, res) => {
  const { username, password, scope } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  }
  if (scope === 'super' && user.role !== 'super') {
    return res.status(403).json({ error: 'スーパー管理者ではありません' });
  }
  if (scope === 'admin' && user.role !== 'admin') {
    return res.status(403).json({ error: '企業管理者ではありません' });
  }
  req.session.userId = user.id;
  res.json(publicUser(user));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  res.json(user ? publicUser(user) : null);
});

function publicUser(user) {
  let tenant = null;
  if (user.tenant_id) {
    tenant = db.prepare('SELECT id, slug, name FROM tenants WHERE id = ?').get(user.tenant_id);
  }
  return { id: user.id, username: user.username, role: user.role, name: user.name, tenant };
}

module.exports = router;
