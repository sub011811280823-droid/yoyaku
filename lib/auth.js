'use strict';

const crypto = require('node:crypto');
const db = require('../db');

// ---- パスワードハッシュ (scrypt) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(calc, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- 認証ミドルウェア ----

// ログイン必須（任意のロール）
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'ログインが必要です' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'ログインが必要です' });
  }
  req.user = user;
  next();
}

// スーパー管理者専用
function requireSuper(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'super') {
      return res.status(403).json({ error: 'スーパー管理者権限が必要です' });
    }
    next();
  });
}

// テナント管理者専用（req.tenantId をセット）
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin' || !req.user.tenant_id) {
      return res.status(403).json({ error: '企業管理者権限が必要です' });
    }
    req.tenantId = req.user.tenant_id;
    next();
  });
}

module.exports = { hashPassword, verifyPassword, requireAuth, requireSuper, requireAdmin };
