'use strict';

const { hashPassword } = require('./auth');

function dateAfter(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// デモデータを投入する。reset=true なら既存データを全削除してから投入。
function seedDatabase(db, { reset = false } = {}) {
  if (reset) {
    db.exec(`
      DELETE FROM answers; DELETE FROM questionnaire_responses;
      DELETE FROM reservation_options; DELETE FROM reservations;
      DELETE FROM employees;
      DELETE FROM questions; DELETE FROM options; DELETE FROM slots; DELETE FROM courses;
      DELETE FROM users; DELETE FROM tenants;
    `);
  }

  // スーパー管理者
  db.prepare(`INSERT INTO users (tenant_id, username, password_hash, role, name) VALUES (NULL, ?, ?, 'super', ?)`)
    .run('superadmin', hashPassword('admin123'), 'スーパー管理者');

  const createTenant = ({ slug, name, subsidy, useRes = 1, useQ = 1, adminUser, loginField = 'employee_code', pwField = 'birthday' }) => {
    const tid = db.prepare(
      'INSERT INTO tenants (slug, name, subsidy, use_reservation, use_questionnaire, login_id_field, password_field, require_employee_login) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
    ).run(slug, name, subsidy, useRes, useQ, loginField, pwField).lastInsertRowid;
    db.prepare(`INSERT INTO users (tenant_id, username, password_hash, role, name) VALUES (?, ?, ?, 'admin', ?)`)
      .run(tid, adminUser, hashPassword('admin123'), name + ' 管理者');
    return tid;
  };

  // --- 企業A: フル機能（ログイン=社員番号 / パスワード=生年月日） ---
  const a = createTenant({ slug: 'demo', name: 'デモ健診センター', subsidy: 3000, adminUser: 'demo-admin' });

  const courseIds = [['一般健診', 8000], ['人間ドック', 35000], ['特定健診', 12000]].map(([n, p]) =>
    db.prepare('INSERT INTO courses (tenant_id, name, price) VALUES (?, ?, ?)').run(a, n, p).lastInsertRowid
  );

  [
    ['胃カメラ', 8000, 'any', null, null],
    ['乳がん検査（マンモグラフィ）', 6000, '女性', 30, null],
    ['前立腺がん検査（PSA）', 3000, '男性', 40, null],
    ['脳ドック（MRI）', 20000, 'any', 50, null],
  ].forEach(([n, p, g, mn, mx]) =>
    db.prepare('INSERT INTO options (tenant_id, name, price, cond_gender, cond_min_age, cond_max_age) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a, n, p, g, mn, mx)
  );

  // 従業員マスタ（ログインID=社員番号, パスワード=生年月日）
  [
    ['E001', '山田 太郎', 'ヤマダ タロウ', 'taro@example.com', '営業部', '1980-05-15', '男性', '090-1000-0001', 5000],
    ['E002', '佐藤 花子', 'サトウ ハナコ', 'hanako@example.com', '人事部', '1985-04-10', '女性', '090-1000-0002', 3000],
    ['E003', '鈴木 一郎', 'スズキ イチロウ', 'ichiro@example.com', '製造部', '1972-11-30', '男性', '090-1000-0003', null],
    ['E004', '田中 美咲', 'タナカ ミサキ', 'misaki@example.com', '総務部', '1990-02-20', '女性', '090-1000-0004', 10000],
    ['E005', '高橋 健', 'タカハシ ケン', 'ken@example.com', '営業部', '1965-08-08', '男性', '090-1000-0005', 8000],
  ].forEach(([code, name, kana, email, dep, bd, g, ph, sub]) =>
    db.prepare(`INSERT INTO employees (tenant_id, employee_code, name, kana, email, department, birthday, gender, phone, subsidy)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(a, code, name, kana, email, dep, bd, g, ph, sub)
  );

  const times = ['09:00', '09:30', '10:00', '10:30', '11:00', '13:30', '14:00', '14:30'];
  for (let d = 1; d <= 5; d++) {
    const date = dateAfter(d);
    for (const cid of courseIds) for (const t of times) {
      db.prepare('INSERT INTO slots (tenant_id, slot_date, start_time, course_id, capacity) VALUES (?, ?, ?, ?, ?)')
        .run(a, date, t, cid, 5);
    }
  }

  [
    ['現在、治療中の病気はありますか？', 'radio', JSON.stringify(['なし', 'あり']), 1],
    ['上記で「あり」の場合、病名をご記入ください', 'text', null, 0],
    ['現在服用中の薬', 'textarea', null, 0],
    ['喫煙習慣', 'radio', JSON.stringify(['吸わない', '過去に吸っていた', '現在吸っている']), 1],
    ['飲酒頻度', 'select', JSON.stringify(['飲まない', '週1-2回', '週3-4回', 'ほぼ毎日']), 0],
    ['現在ある自覚症状（複数選択可）', 'checkbox', JSON.stringify(['頭痛', 'めまい', '動悸', '胃の不調', '関節痛', '特になし']), 0],
    ['1日の平均睡眠時間', 'number', null, 0],
  ].forEach(([label, type, choices, req], i) =>
    db.prepare('INSERT INTO questions (tenant_id, label, type, choices, required, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
      .run(a, label, type, choices, req, i + 1)
  );

  // サンプル予約（E002 佐藤花子）
  const firstSlot = db.prepare('SELECT id FROM slots WHERE tenant_id = ? ORDER BY id LIMIT 1').get(a).id;
  const emp2 = db.prepare("SELECT id FROM employees WHERE tenant_id = ? AND employee_code = 'E002'").get(a).id;
  db.prepare(`INSERT INTO reservations (tenant_id, slot_id, employee_id, name, kana, birthday, gender, phone, email, course_price, options_total, subsidy, self_pay)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(a, firstSlot, emp2, '佐藤 花子', 'サトウ ハナコ', '1985-04-10', '女性', '090-1000-0002', 'hanako@example.com', 8000, 6000, 3000, 11000);

  // --- 企業B: 問診のみ（予約機能OFF） ---
  createTenant({ slug: 'clinicb', name: 'B総合クリニック', subsidy: 0, useRes: 0, useQ: 1, adminUser: 'clinicb-admin' });
}

function seedIfEmpty(db) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) { seedDatabase(db, { reset: false }); return true; }
  return false;
}

const ACCOUNTS_NOTE = [
  '  スーパー管理者: superadmin / admin123  → /super/login',
  '  企業A 管理者:   demo-admin / admin123   → /admin/login  受診者: /t/demo',
  '  企業A 従業員例: 社員番号 E001 / パスワード(生年月日) 1980-05-15 → /t/demo',
  '  企業B 管理者:   clinicb-admin / admin123 → /admin/login  受診者: /t/clinicb（予約OFF・問診のみ）',
].join('\n');

module.exports = { seedDatabase, seedIfEmpty, ACCOUNTS_NOTE };
