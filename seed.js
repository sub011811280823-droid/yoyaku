'use strict';

// サンプルデータ投入（既存データを全削除して再投入）: node seed.js
const db = require('./db');
const { seedDatabase, ACCOUNTS_NOTE } = require('./lib/sampleData');

seedDatabase(db, { reset: true });

console.log('投入完了:');
console.log(ACCOUNTS_NOTE);
