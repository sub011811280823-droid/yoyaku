'use strict';

const express = require('express');
const db = require('../db');
const { requireSuper, hashPassword } = require('../lib/auth');

const router = express.Router();
router.use(requireSuper);

const SLUG_RE = /^[a-z0-9-]+$/;

// テナント一覧（管理者ユーザー・予約件数付き）
router.get('/tenants', (req, res) => {
  const tenants = db.prepare('SELECT * FROM tenants ORDER BY id').all();
  const result = tenants.map((t) => {
    const admins = db
      .prepare(`SELECT username, name FROM users WHERE tenant_id = ? AND role = 'admin'`)
      .all(t.id);
    const resCount = db
      .prepare('SELECT COUNT(*) AS c FROM reservations WHERE tenant_id = ?')
      .get(t.id).c;
    return { ...t, admins, reservationCount: resCount };
  });
  res.json(result);
});

// テナント作成（同時に管理者ユーザーを1人作成）
router.post('/tenants', (req, res) => {
  const { slug, name, adminUsername, adminPassword, adminName } = req.body || {};
  if (!slug || !name || !adminUsername || !adminPassword) {
    return res.status(400).json({ error: 'slug・企業名・管理者ID・管理者パスワードは必須です' });
  }
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'slugは英小文字・数字・ハイフンのみ使用できます' });
  }
  if (db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(slug)) {
    return res.status(400).json({ error: 'このslugは既に使われています' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(adminUsername)) {
    return res.status(400).json({ error: 'この管理者IDは既に使われています' });
  }
  try {
    const result = db.tx(() => {
      const info = db
        .prepare('INSERT INTO tenants (slug, name) VALUES (?, ?)')
        .run(slug, name);
      const tenantId = info.lastInsertRowid;
      db.prepare(
        `INSERT INTO users (tenant_id, username, password_hash, role, name)
         VALUES (?, ?, ?, 'admin', ?)`
      ).run(tenantId, adminUsername, hashPassword(adminPassword), adminName || name + ' 管理者');
      return tenantId;
    });
    res.status(201).json(db.prepare('SELECT * FROM tenants WHERE id = ?').get(result));
  } catch (e) {
    res.status(500).json({ error: '作成に失敗しました: ' + e.message });
  }
});

// テナント更新（企業名・機能ON/OFF・補助額）
router.patch('/tenants/:id', (req, res) => {
  const id = Number(req.params.id);
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  if (!t) return res.status(404).json({ error: '企業が見つかりません' });
  const { name, use_reservation, use_questionnaire, subsidy } = req.body || {};
  db.prepare(
    `UPDATE tenants SET
       name = COALESCE(?, name),
       use_reservation = COALESCE(?, use_reservation),
       use_questionnaire = COALESCE(?, use_questionnaire),
       subsidy = COALESCE(?, subsidy)
     WHERE id = ?`
  ).run(
    name ?? null,
    use_reservation == null ? null : (use_reservation ? 1 : 0),
    use_questionnaire == null ? null : (use_questionnaire ? 1 : 0),
    subsidy == null ? null : Number(subsidy),
    id
  );
  res.json(db.prepare('SELECT * FROM tenants WHERE id = ?').get(id));
});

// 管理者のパスワードリセット
router.post('/tenants/:id/reset-password', (req, res) => {
  const id = Number(req.params.id);
  const { username, newPassword } = req.body || {};
  if (!username || !newPassword) return res.status(400).json({ error: '管理者IDと新しいパスワードが必要です' });
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND tenant_id = ?').get(username, id);
  if (!user) return res.status(404).json({ error: '対象の管理者が見つかりません' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), user.id);
  res.json({ ok: true });
});

// テナント削除（関連データもカスケード削除）
router.delete('/tenants/:id', (req, res) => {
  const info = db.prepare('DELETE FROM tenants WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: '企業が見つかりません' });
  res.status(204).end();
});

module.exports = router;
