'use strict';

// 生年月日(YYYY-MM-DD)から受診日時点の満年齢を計算
function ageAt(birthday, refDate) {
  if (!birthday) return null;
  const b = new Date(birthday);
  const r = refDate ? new Date(refDate) : new Date();
  if (Number.isNaN(b.getTime())) return null;
  let age = r.getFullYear() - b.getFullYear();
  const m = r.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && r.getDate() < b.getDate())) age--;
  return age;
}

// オプションが受診者の条件に合致するか
function isEligible(option, { gender, age }) {
  if (option.cond_gender && option.cond_gender !== 'any') {
    if (option.cond_gender !== gender) return false;
  }
  if (option.cond_min_age != null && (age == null || age < option.cond_min_age)) return false;
  if (option.cond_max_age != null && (age == null || age > option.cond_max_age)) return false;
  return true;
}

// 条件を人が読める文字列に
function conditionLabel(option) {
  const parts = [];
  if (option.cond_gender && option.cond_gender !== 'any') parts.push(option.cond_gender + '限定');
  if (option.cond_min_age != null && option.cond_max_age != null) parts.push(`${option.cond_min_age}〜${option.cond_max_age}歳`);
  else if (option.cond_min_age != null) parts.push(`${option.cond_min_age}歳以上`);
  else if (option.cond_max_age != null) parts.push(`${option.cond_max_age}歳以下`);
  return parts.length ? parts.join(' / ') : '条件なし';
}

// 自己負担額の計算: max(0, コース料金 + オプション合計 - 補助額)
function computeCost({ coursePrice, optionPrices, subsidy }) {
  const course = Number(coursePrice) || 0;
  const optionsTotal = (optionPrices || []).reduce((s, p) => s + (Number(p) || 0), 0);
  const sub = Number(subsidy) || 0;
  const selfPay = Math.max(0, course + optionsTotal - sub);
  return { coursePrice: course, optionsTotal, subsidy: sub, selfPay };
}

module.exports = { ageAt, isEligible, conditionLabel, computeCost };
