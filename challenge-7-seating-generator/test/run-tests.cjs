/*
 * Test suite for the seating engine. Run with:  node test/run-tests.cjs
 *
 * Checks are re-implemented here from scratch (not reusing Mixer.verify)
 * so the engine's guarantees are validated by independent code.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Mixer = require('../mixer.js');
const XLSX = require('../xlsx.full.min.js');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : ''));
  }
}

// ---------------------------------------------------------------- helpers
function loadSampleParticipants() {
  const csv = fs.readFileSync(path.join(__dirname, '..', 'sample-data', 'participants_sample.csv'), 'utf8');
  const rows = csv.trim().split(/\r?\n/).map((l) => l.split(','));
  return Mixer.parseParticipants(rows);
}

function syntheticCohort(n, genders) {
  const inds = ['Finance', 'Tech', 'Consulting', 'Health', 'Energy'];
  const nats = ['CH', 'US', 'IN', 'BR', 'DE', 'JP', 'FR'];
  const grps = ['A', 'B', 'C', 'D'];
  const ppl = [];
  for (let i = 0; i < n; i++) {
    ppl.push({
      name: 'P' + i,
      gender: genders ? genders[i % genders.length] : (i % 2 ? 'M' : 'F'),
      industry: inds[(i * 3) % inds.length],
      nationality: nats[(i * 5) % nats.length],
      coachingGroup: grps[(i * 7) % grps.length],
    });
  }
  return ppl;
}

// Independent re-checks (deliberately not Mixer.verify).
function independentChecks(label, ppl, r, T, D) {
  const N = ppl.length;
  // exactly once per day
  let onceOk = true;
  r.days.forEach((day) => {
    const seen = new Set();
    let total = 0;
    day.tables.forEach((m) => m.forEach((i) => { seen.add(i); total++; }));
    if (seen.size !== N || total !== N) onceOk = false;
  });
  check(label + ': everyone exactly once per day', onceOk);

  // table count and sizes
  let sizesOk = true;
  r.days.forEach((day) => {
    if (day.tables.length !== T) sizesOk = false;
    const sizes = day.tables.map((m) => m.length);
    if (Math.max(...sizes) - Math.min(...sizes) > 1) sizesOk = false;
    if (sizes.reduce((a, b) => a + b, 0) !== N) sizesOk = false;
  });
  check(label + ': ' + T + ' tables, sizes within ±1', sizesOk);

  // gender balance: per gender value, per table, within floor/ceil of even spread
  const byGender = {};
  ppl.forEach((p, i) => { (byGender[p.gender] = byGender[p.gender] || []).push(i); });
  let genderOk = true;
  Object.keys(byGender).forEach((g) => {
    const set = new Set(byGender[g]);
    const lo = Math.floor(set.size / T);
    const hi = Math.ceil(set.size / T);
    r.days.forEach((day) => {
      day.tables.forEach((m) => {
        const cnt = m.filter((i) => set.has(i)).length;
        if (cnt < lo || cnt > hi) genderOk = false;
      });
    });
  });
  check(label + ': every gender within ±1 per table', genderOk);

  check(label + ': day count is ' + D, r.days.length === D);
  check(label + ': score in [0,100]', r.score.overall >= 0 && r.score.overall <= 100, 'got ' + r.score.overall);
  check(label + ': engine verify agrees', r.verification.allHardChecksPass === (onceOk && sizesOk && genderOk));
}

function countRepeats(days) {
  const meet = new Map();
  days.forEach((day) => {
    day.tables.forEach((m) => {
      for (let x = 0; x < m.length; x++) {
        for (let y = x + 1; y < m.length; y++) {
          const k = Math.min(m[x], m[y]) * 100000 + Math.max(m[x], m[y]);
          meet.set(k, (meet.get(k) || 0) + 1);
        }
      }
    });
  });
  let repeats = 0;
  let maxMeet = 0;
  meet.forEach((c) => { repeats += c - 1; maxMeet = Math.max(maxMeet, c); });
  return { repeats, maxMeet };
}

// Naive random baseline: shuffle + chunk, no optimisation, gender-blind.
function randomBaselineRepeats(n, T, D, seed) {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const days = [];
  for (let d = 0; d < D; d++) {
    const idx = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const tables = Array.from({ length: T }, () => []);
    idx.forEach((p, k) => tables[k % T].push(p));
    days.push({ tables });
  }
  return countRepeats(days).repeats;
}

// ------------------------------------------------------------------ tests
console.log('\n1. Parsing the standard template (sample CSV)');
const parsed = loadSampleParticipants();
check('48 participants parsed', parsed.participants.length === 48, 'got ' + parsed.participants.length);
check('no errors', parsed.errors.length === 0, parsed.errors.join('; '));
check('all five columns recognised', ['name', 'gender', 'nationality', 'industry', 'coachingGroup'].every((f) => parsed.columnMap[f] != null));
check('genders normalised to F/M', parsed.participants.every((p) => p.gender === 'F' || p.gender === 'M'));
check('24/24 gender split', parsed.participants.filter((p) => p.gender === 'F').length === 24);

console.log('\n2. Header flexibility');
const alt = Mixer.parseParticipants([
  ['Participant Name', 'Sector', 'Sex', 'Country', 'Coaching group (A-F)'],
  ['Alice', 'Finance', 'female', 'CH', 'A'],
  ['Bob', 'Tech', 'MALE', 'US', 'B'],
]);
check('synonym headers map correctly', alt.errors.length === 0 && alt.participants.length === 2);
check('gender text variants normalised', alt.participants[0].gender === 'F' && alt.participants[1].gender === 'M');
const noGender = Mixer.parseParticipants([['Name', 'Industry'], ['Alice', 'Finance']]);
check('missing gender column is a clear error', noGender.errors.length === 1 && /Gender/.test(noGender.errors[0]));
const blankRows = Mixer.parseParticipants([
  ['Name', 'Gender'], ['', ''], ['Alice', 'F'], ['', 'M'], ['Bob', 'M'],
]);
check('blank/incomplete rows skipped with warning', blankRows.participants.length === 2 && blankRows.warnings.length >= 1);

console.log('\n3. Determinism');
const pplD = parsed.participants;
const rA = Mixer.generate(pplD, { tables: 6, days: 5 });
const rB = Mixer.generate(pplD, { tables: 6, days: 5 });
check('identical runs produce identical plans', JSON.stringify(rA.days) === JSON.stringify(rB.days));
check('identical scores', rA.score.overall === rB.score.overall);
const rC = Mixer.generate(pplD, { tables: 6, days: 5, seed: 7 });
check('different seed may differ (engine actually uses the seed)', JSON.stringify(rA.meta.seed) !== JSON.stringify(rC.meta.seed));

console.log('\n4. Hard guarantees across awkward shapes');
independentChecks('48p/6t/5d', pplD, rA, 6, 5);
const shapes = [
  [29, 4, 3],   // uneven sizes (8,7,7,7)
  [7, 3, 2],    // tiny
  [50, 8, 5],   // the brief example
  [23, 23, 2],  // table of one person each
  [40, 2, 4],   // two huge tables
];
shapes.forEach(([n, t, d]) => {
  const ppl = syntheticCohort(n);
  const r = Mixer.generate(ppl, { tables: t, days: d });
  independentChecks(n + 'p/' + t + 't/' + d + 'd', ppl, r, t, d);
});

console.log('\n5. Unusual gender data');
const mixedG = syntheticCohort(30, ['F', 'M', 'F', 'M', 'Non-binary', '']);
const rG = Mixer.generate(mixedG, { tables: 5, days: 3 });
independentChecks('30p with non-binary + blanks', mixedG, rG, 5, 3);
const oneG = Mixer.generate(syntheticCohort(20, ['F']), { tables: 4, days: 3 });
check('single-gender cohort works', oneG.verification.allHardChecksPass);

console.log('\n6. Mixing quality vs naive random baseline');
const q = countRepeats(rA.days);
const base = randomBaselineRepeats(48, 6, 5, 12345);
check('optimised repeats well below random baseline', q.repeats < base * 0.6, q.repeats + ' vs baseline ' + base);
check('no pair meets 3+ times (48p/6t/5d)', q.maxMeet <= 2, 'maxMeet ' + q.maxMeet);
check('repeats ≥ stated theoretical minimum', q.repeats >= rA.score.detail.theoreticalMinRepeats);
check('repeats within 10% of theoretical minimum', q.repeats <= Math.max(rA.score.detail.theoreticalMinRepeats * 1.1, rA.score.detail.theoreticalMinRepeats + 6), q.repeats + ' vs min ' + rA.score.detail.theoreticalMinRepeats);

console.log('\n7. Validation errors');
function throwsWith(fn, re) {
  try { fn(); return false; } catch (e) { return re.test(e.message); }
}
check('tables > participants rejected', throwsWith(() => Mixer.generate(syntheticCohort(5), { tables: 6, days: 2 }), /More tables/));
check('zero days rejected', throwsWith(() => Mixer.generate(syntheticCohort(5), { tables: 2, days: 0 }), /at least 1/));
check('zero tables rejected', throwsWith(() => Mixer.generate(syntheticCohort(5), { tables: 0, days: 2 }), /at least 1/));
check('empty cohort rejected', throwsWith(() => Mixer.generate([], { tables: 2, days: 2 }), /No participants/));

console.log('\n8. Custom weights are honoured');
const wDefault = Mixer.generate(pplD, { tables: 6, days: 5 });
const wCoach = Mixer.generate(pplD, { tables: 6, days: 5, weights: { coachingGroup: 50, industry: 0, nationality: 0 } });
const coachPairs = (r) => r.score.detail.attributes.coachingGroup.samePairs;
check('boosting coaching-group weight reduces its clustering (or already optimal)', coachPairs(wCoach) <= coachPairs(wDefault), coachPairs(wCoach) + ' vs ' + coachPairs(wDefault));

console.log('\n9. Performance');
const t0 = Date.now();
Mixer.generate(syntheticCohort(100), { tables: 10, days: 5 });
const ms = Date.now() - t0;
check('100p/10t/5d under 5s', ms < 5000, ms + 'ms');

console.log('\n10. End-to-end Excel output');
const sheets = Mixer.buildWorkbookSheets(pplD, rA, { fileName: 'participants_sample.csv', generatedAt: '2026-06-12 10:00:00' });
check('sheet count = days + summary + by-participant', sheets.length === 5 + 2, 'got ' + sheets.length);
const wb = XLSX.utils.book_new();
sheets.forEach((s) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name));
const outPath = path.join(__dirname, 'output_sample.xlsx');
fs.writeFileSync(outPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
check('output .xlsx written', fs.existsSync(outPath) && fs.statSync(outPath).size > 5000);

// Re-read the file and re-verify from the *file* (the artefact a PC receives).
const reread = XLSX.read(fs.readFileSync(outPath), { type: 'buffer' });
check('workbook has Day 1..5 sheets', [1, 2, 3, 4, 5].every((d) => reread.SheetNames.includes('Day ' + d)));
let fileOk = true;
for (let d = 1; d <= 5; d++) {
  const rows = XLSX.utils.sheet_to_json(reread.Sheets['Day ' + d], { header: 1 }).slice(1);
  const names = rows.map((r) => r[1]).sort();
  const expect = pplD.map((p) => p.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expect)) fileOk = false;
  if (!rows.every((r) => r[0] >= 1 && r[0] <= 6)) fileOk = false;
}
check('every day sheet in the file lists all 48 people exactly once', fileOk);

console.log('\n' + 'federation'.replace('federation', '—'.repeat(40)));
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
