'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const db = require('./db');
const { seedIfEmpty, ACCOUNTS_NOTE } = require('./lib/sampleData');

const app = express();
const PORT = process.env.PORT || 3000;

// 初回起動時（ユーザーが1人もいない場合）はデモデータを自動投入
const seeded = seedIfEmpty(db);

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'yoyaku-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
}));

// ---- API ----
app.use('/api/auth', require('./routes/auth'));
app.use('/api/super', require('./routes/super'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/t', require('./routes/public'));

// ---- 静的ファイル ----
const PUB = path.join(__dirname, 'public');
app.use(express.static(PUB));

// ---- 画面ルーティング（SPA的に各HTMLを返す） ----
const page = (file) => (req, res) => res.sendFile(path.join(PUB, file));

app.get('/', page('landing.html'));
app.get('/super', page('super.html'));
app.get('/super/login', page('login.html'));
app.get('/admin', page('admin.html'));
app.get('/admin/login', page('login.html'));
// 受診者：予約・問診（slugはJS側でパスから取得）
app.get('/t/:slug', page('reserve.html'));
app.get('/t/:slug/questionnaire', page('questionnaire.html'));

app.listen(PORT, () => {
  console.log(`健康診断 予約・問診アプリ起動: http://localhost:${PORT}`);
  if (seeded) {
    console.log('デモデータを自動投入しました。ログイン情報:');
    console.log(ACCOUNTS_NOTE);
  } else {
    console.log('  受診者:        /t/:slug');
    console.log('  企業管理者:    /admin/login');
    console.log('  スーパー管理者: /super/login');
  }
});
