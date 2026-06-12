/*
 * mixer.js — deterministic seating-group engine (Vibe Coding Workshop, Challenge #7)
 *
 * Guarantees, by construction:
 *   1. Every participant appears exactly once per daily configuration.
 *   2. Table sizes differ by at most 1.
 *   3. Each gender is spread across tables as evenly as possible (±1 per table).
 * Optimised, by deterministic local search (no LLM, no Math.random):
 *   4. Repeat pairings across days are minimised.
 *   5. Same-attribute clustering (industry / nationality / coaching group) is minimised.
 *
 * Same input + same settings → byte-identical output, every time.
 * Runs in the browser (window.Mixer) and in Node (module.exports). No dependencies.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Mixer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- PRNG --
  // Fixed-seed mulberry32: the only source of "randomness", fully reproducible.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  // ------------------------------------------------------ input parsing --
  const FIELDS = ['name', 'gender', 'nationality', 'industry', 'coachingGroup'];
  const FIELD_LABELS = {
    name: 'Name',
    gender: 'Gender',
    nationality: 'Nationality',
    industry: 'Industry',
    coachingGroup: 'Coaching Group',
  };
  const SYNONYMS = {
    name: ['name', 'participant', 'participantname', 'fullname', 'participantfullname'],
    gender: ['gender', 'sex', 'mf', 'genre'],
    nationality: ['nationality', 'country', 'citizenship', 'nationalite'],
    industry: ['industry', 'sector', 'industrysector', 'secteur'],
    coachingGroup: ['coachinggroup', 'coachgroup', 'coachingteam', 'coaching', 'studygroup', 'group', 'team', 'groupe'],
  };

  function canon(h) {
    return String(h == null ? '' : h).toLowerCase().replace(/[^a-z]/g, '');
  }

  function normGender(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '(not specified)';
    const c = s.toLowerCase();
    if (['f', 'female', 'woman', 'w', 'fem'].indexOf(c) >= 0) return 'F';
    if (['m', 'male', 'man', 'h'].indexOf(c) >= 0) return 'M';
    return s.charAt(0).toUpperCase() + s.slice(1); // any other value becomes its own balanced class
  }

  /**
   * parseParticipants(rows): rows is an array-of-arrays (first non-empty row = headers).
   * Returns { participants, columnMap, errors, warnings }.
   * Only Name and Gender are required; missing attribute columns simply drop
   * that diversity criterion (with a warning).
   */
  function parseParticipants(rows) {
    const errors = [];
    const warnings = [];

    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      if ((rows[i] || []).some(function (c) { return String(c == null ? '' : c).trim() !== ''; })) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) return { participants: [], columnMap: {}, extraColumns: [], errors: ['The file is empty.'], warnings: warnings };

    const headers = rows[headerIdx].map(function (h) { return String(h == null ? '' : h).trim(); });
    const canonHeaders = headers.map(canon);

    // Two passes: exact synonym match first, then "contains" as fallback.
    const columnMap = {};
    const used = {};
    FIELDS.forEach(function (field) {
      for (let c = 0; c < canonHeaders.length; c++) {
        if (used[c]) continue;
        if (SYNONYMS[field].indexOf(canonHeaders[c]) >= 0) {
          columnMap[field] = c;
          used[c] = true;
          return;
        }
      }
    });
    FIELDS.forEach(function (field) {
      if (columnMap[field] != null) return;
      for (let c = 0; c < canonHeaders.length; c++) {
        if (used[c] || !canonHeaders[c]) continue;
        const hit = SYNONYMS[field].some(function (s) { return canonHeaders[c].indexOf(s) >= 0; });
        if (hit) {
          columnMap[field] = c;
          used[c] = true;
          return;
        }
      }
    });

    // Any column not claimed by a known field becomes a user-defined extra attribute.
    const extraKeysSeen = {};
    const extraColumns = [];
    for (let c = 0; c < headers.length; c++) {
      if (used[c] || !headers[c].trim() || !canonHeaders[c]) continue;
      let baseKey = 'ext_' + canonHeaders[c];
      let key = baseKey;
      let n = 2;
      while (extraKeysSeen[key]) { key = baseKey + '_' + (n++); }
      extraKeysSeen[key] = true;
      extraColumns.push({ key: key, label: headers[c].trim(), colIdx: c });
    }

    if (columnMap.name == null) {
      errors.push('Could not find a "Name" column. Found headers: ' + headers.filter(Boolean).join(', '));
    }
    if (columnMap.gender == null) {
      errors.push('Could not find a "Gender" column (needed to enforce gender balance). Found headers: ' + headers.filter(Boolean).join(', '));
    }
    ['nationality', 'industry', 'coachingGroup'].forEach(function (f) {
      if (columnMap[f] == null) warnings.push('No "' + FIELD_LABELS[f] + '" column found — that mixing criterion will be skipped.');
    });
    if (errors.length) return { participants: [], columnMap: columnMap, extraColumns: extraColumns, errors: errors, warnings: warnings };

    const participants = [];
    const seen = {};
    const dupes = [];
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const get = function (f) {
        return columnMap[f] == null ? '' : String(row[columnMap[f]] == null ? '' : row[columnMap[f]]).trim();
      };
      const name = get('name');
      const isEmptyRow = row.every(function (c) { return String(c == null ? '' : c).trim() === ''; });
      if (isEmptyRow) continue;
      if (!name) {
        warnings.push('Row ' + (r + 1) + ' has no name and was skipped.');
        continue;
      }
      const key = name.toLowerCase();
      if (seen[key]) dupes.push(name);
      seen[key] = true;
      const p = {
        name: name,
        gender: normGender(get('gender')),
        nationality: get('nationality'),
        industry: get('industry'),
        coachingGroup: get('coachingGroup'),
      };
      extraColumns.forEach(function (ec) {
        p[ec.key] = String(row[ec.colIdx] == null ? '' : row[ec.colIdx]).trim();
      });
      participants.push(p);
    }
    if (dupes.length) warnings.push('Duplicate names found (kept as separate people): ' + dupes.join(', '));
    if (!participants.length) errors.push('No participant rows found below the header row.');
    return { participants: participants, columnMap: columnMap, extraColumns: extraColumns, errors: errors, warnings: warnings };
  }

  // ------------------------------------------------------------ engine --
  const ATTRS = ['coachingGroup', 'industry', 'nationality'];
  const DEFAULT_WEIGHTS = { repeat: 10, coachingGroup: 3, industry: 2, nationality: 2 };
  const SCORE_SHARES = { repeat: 0.40, coachingGroup: 0.20, industry: 0.15, nationality: 0.15, gender: 0.10 };

  /**
   * generate(participants, opts)
   *   participants: [{name, gender, nationality, industry, coachingGroup}]
   *   opts: { tables, days, weights?, starts?, maxPasses?, seed? }
   * Returns { days: [{tables:[[pIdx]], tableOf:[tIdx]}], score, verification, meta }
   */
  function generate(participants, opts) {
    const N = participants.length;
    const T = Math.floor(opts.tables);
    const D = Math.floor(opts.days);
    if (!N) throw new Error('No participants to seat.');
    if (!(T >= 1)) throw new Error('Number of tables must be at least 1.');
    if (T > N) throw new Error('More tables (' + T + ') than participants (' + N + ') — every table needs at least one person.');
    if (!(D >= 1)) throw new Error('Number of daily configurations must be at least 1.');
    if (D > 60) throw new Error('Daily configurations capped at 60.');

    const extraAttrs = (opts.extraAttrs || []).map(function (ea) { return ea.key; });
    const allAttrs = ATTRS.concat(extraAttrs);

    const weights = Object.assign({}, DEFAULT_WEIGHTS, opts.weights || {});
    extraAttrs.forEach(function (key) { if (weights[key] == null) weights[key] = 2; });

    const baseSeed = (opts.seed == null ? 42 : opts.seed) >>> 0;
    // Effort scales down for very large groups so generation stays fast.
    const starts = opts.starts || (N <= 80 ? 12 : N <= 160 ? 8 : 4);
    const maxPasses = opts.maxPasses || (N <= 80 ? 30 : N <= 160 ? 18 : 10);

    // Gender classes, deterministic order (largest first, then alphabetical).
    const classMap = {};
    participants.forEach(function (p, i) {
      (classMap[p.gender] = classMap[p.gender] || []).push(i);
    });
    const classNames = Object.keys(classMap).sort(function (a, b) {
      return classMap[b].length - classMap[a].length || (a < b ? -1 : 1);
    });
    const classes = classNames.map(function (g) { return classMap[g]; });
    const classOf = new Int32Array(N);
    classes.forEach(function (members, ci) {
      members.forEach(function (i) { classOf[i] = ci; });
    });

    // Attribute value encoding; blank values get -1 (never penalised).
    const attrCodes = {};
    const attrActive = {};
    allAttrs.forEach(function (a) {
      const codeOf = {};
      let next = 0;
      const arr = new Int32Array(N);
      participants.forEach(function (p, i) {
        const v = String(p[a] || '').trim().toLowerCase();
        if (!v) { arr[i] = -1; return; }
        if (!(v in codeOf)) codeOf[v] = next++;
        arr[i] = codeOf[v];
      });
      attrCodes[a] = arr;
      attrActive[a] = next > 1; // criterion only meaningful with ≥2 distinct values
    });
    const activeAttrs = allAttrs.filter(function (a) { return attrActive[a]; });

    const pairCount = new Uint16Array(N * N);
    const pk = function (i, j) { return i < j ? i * N + j : j * N + i; };

    // Cost of one person against one table (optionally skipping one member slot).
    // Repeat penalty is quadratic in prior meetings: a 3rd encounter costs 4×
    // a 2nd, so the search strongly prefers spreading repeats thin.
    function personCost(p, members, skipIdx) {
      let c = 0;
      for (let k = 0; k < members.length; k++) {
        if (k === skipIdx) continue;
        const q = members[k];
        if (q === p) continue;
        const r = pairCount[pk(p, q)];
        c += weights.repeat * r * r;
        for (let ai = 0; ai < activeAttrs.length; ai++) {
          const a = activeAttrs[ai];
          const vp = attrCodes[a][p];
          if (vp >= 0 && vp === attrCodes[a][q]) c += weights[a];
        }
      }
      return c;
    }

    function dayCost(tablesArr) {
      let c = 0;
      for (let t = 0; t < tablesArr.length; t++) {
        const m = tablesArr[t];
        for (let x = 0; x < m.length; x++) {
          for (let y = x + 1; y < m.length; y++) {
            const r = pairCount[pk(m[x], m[y])];
            c += weights.repeat * r * r;
            for (let ai = 0; ai < activeAttrs.length; ai++) {
              const a = activeAttrs[ai];
              const vx = attrCodes[a][m[x]];
              if (vx >= 0 && vx === attrCodes[a][m[y]]) c += weights[a];
            }
          }
        }
      }
      return c;
    }

    // Gender-stratified continuous round-robin deal.
    // One running pointer across all classes ⇒ table sizes ±1 AND each class ±1 per table.
    // When prevTableOf is given, members of each class are interleaved by their
    // previous day's table, so yesterday's tablemates scatter structurally.
    function deal(rng, prevTableOf) {
      const tablesArr = [];
      for (let t = 0; t < T; t++) tablesArr.push([]);
      let p = Math.floor(rng() * T);
      classes.forEach(function (members) {
        let order = shuffle(members.slice(), rng);
        if (prevTableOf) {
          const buckets = [];
          for (let t = 0; t < T; t++) buckets.push([]);
          order.forEach(function (m) { buckets[prevTableOf[m]].push(m); });
          order = [];
          let added = true;
          while (added) {
            added = false;
            for (let t = 0; t < T; t++) {
              if (buckets[t].length) {
                order.push(buckets[t].pop());
                added = true;
              }
            }
          }
        }
        for (let k = 0; k < order.length; k++) {
          tablesArr[p % T].push(order[k]);
          p++;
        }
      });
      return tablesArr;
    }

    // Perturbation for iterated local search: a few random same-gender swaps.
    function kick(tablesArr, rng, count) {
      for (let n = 0; n < count; n++) {
        const tx = Math.floor(rng() * T);
        let ty = Math.floor(rng() * (T - 1));
        if (ty >= tx) ty++;
        const A = tablesArr[tx];
        const B = tablesArr[ty];
        for (let tries = 0; tries < 20; tries++) {
          const ia = Math.floor(rng() * A.length);
          const ib = Math.floor(rng() * B.length);
          if (classOf[A[ia]] === classOf[B[ib]]) {
            const tmp = A[ia];
            A[ia] = B[ib];
            B[ib] = tmp;
            break;
          }
        }
      }
    }

    // Local search: swap two SAME-GENDER people between two tables (keeps all
    // structural guarantees intact). First-improvement, fixed pass budget.
    function localSearch(tablesArr) {
      let improved = true;
      let passes = 0;
      while (improved && passes < maxPasses) {
        improved = false;
        passes++;
        for (let tx = 0; tx < T - 1; tx++) {
          for (let ty = tx + 1; ty < T; ty++) {
            const A = tablesArr[tx];
            const B = tablesArr[ty];
            for (let ia = 0; ia < A.length; ia++) {
              for (let ib = 0; ib < B.length; ib++) {
                const a = A[ia];
                const b = B[ib];
                if (classOf[a] !== classOf[b]) continue;
                const before = personCost(a, A, ia) + personCost(b, B, ib);
                const after = personCost(a, B, ib) + personCost(b, A, ia);
                if (after < before) {
                  A[ia] = b;
                  B[ib] = a;
                  improved = true;
                }
              }
            }
          }
        }
      }
    }

    const daysOut = [];
    let prevTableOf = null;
    for (let d = 0; d < D; d++) {
      let best = null;
      for (let s = 0; s < starts; s++) {
        const rng = mulberry32(baseSeed ^ (d * 1000003 + s * 7919 + 0x9e3779b9));
        // First two starts scatter yesterday's tablemates structurally; the rest are random.
        const tablesArr = deal(rng, s < 2 && prevTableOf ? prevTableOf : null);
        localSearch(tablesArr);
        let cand = { tables: tablesArr, cost: dayCost(tablesArr) };
        // Iterated local search: perturb, re-descend, keep only improvements.
        for (let r = 0; r < 3; r++) {
          const copy = cand.tables.map(function (m) { return m.slice(); });
          kick(copy, rng, 3);
          localSearch(copy);
          const c = dayCost(copy);
          if (c < cand.cost) cand = { tables: copy, cost: c };
        }
        if (best === null || cand.cost < best.cost) best = cand;
      }
      // Commit the day: record pairings.
      best.tables.forEach(function (m) {
        for (let x = 0; x < m.length; x++) {
          for (let y = x + 1; y < m.length; y++) pairCount[pk(m[x], m[y])]++;
        }
      });
      const tableOf = new Array(N);
      best.tables.forEach(function (m, t) {
        m.forEach(function (i) { tableOf[i] = t; });
      });
      prevTableOf = tableOf;
      // Sort members within each table for stable display.
      const tablesSorted = best.tables.map(function (m) {
        return m.slice().sort(function (x, y) {
          return participants[x].name < participants[y].name ? -1 : 1;
        });
      });
      daysOut.push({ tables: tablesSorted, tableOf: tableOf });
    }

    const score = computeScore(participants, daysOut, T, D, pairCount, attrCodes, activeAttrs, classes, classNames);
    const verification = verify(participants, daysOut, T);
    return {
      days: daysOut,
      score: score,
      verification: verification,
      meta: {
        participants: N,
        tables: T,
        days: D,
        seed: baseSeed,
        starts: starts,
        weights: weights,
        activeAttrs: activeAttrs.slice(),
        extraAttrs: opts.extraAttrs || [],
        genderClasses: classNames.map(function (g, i) { return { gender: g, count: classes[i].length }; }),
      },
    };
  }

  // ----------------------------------------------------------- scoring --
  function comb2(n) { return (n * (n - 1)) / 2; }

  // Best possible same-value pairs for one day (pigeonhole spread).
  function bestSamePairs(valueCounts, T) {
    let pairs = 0;
    valueCounts.forEach(function (n) {
      const q = Math.floor(n / T);
      const r = n % T;
      pairs += r * comb2(q + 1) + (T - r) * comb2(q);
    });
    return pairs;
  }

  // Worst plausible same-value pairs for one day (cluster values into tables).
  function worstSamePairs(valueCounts, tableSizes) {
    const caps = tableSizes.slice();
    let pairs = 0;
    valueCounts.slice().sort(function (a, b) { return b - a; }).forEach(function (n) {
      let left = n;
      while (left > 0) {
        caps.sort(function (a, b) { return b - a; });
        if (caps[0] <= 0) break;
        const put = Math.min(left, caps[0]);
        pairs += comb2(put);
        caps[0] -= put;
        left -= put;
      }
    });
    return pairs;
  }

  function clampScore(x) { return Math.max(0, Math.min(100, x)); }

  function computeScore(participants, daysOut, T, D, pairCount, attrCodes, activeAttrs, classes, classNames) {
    const N = participants.length;
    const tableSizes = daysOut[0].tables.map(function (m) { return m.length; });
    const meetingsPerDay = tableSizes.reduce(function (s, n) { return s + comb2(n); }, 0);
    const M = meetingsPerDay * D;

    // Repeat pairings.
    let U = 0;
    let maxMeet = 0;
    const repeatPairs = [];
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const c = pairCount[i * N + j];
        if (c >= 1) U++;
        if (c > maxMeet) maxMeet = c;
        if (c >= 2) repeatPairs.push({ a: participants[i].name, b: participants[j].name, times: c });
      }
    }
    repeatPairs.sort(function (x, y) { return y.times - x.times || (x.a < y.a ? -1 : 1); });
    const R = M - U;
    const Rworst = M - meetingsPerDay;
    // Theoretical floor: when a table seats more people (k) than there are
    // tables (T), pigeonhole forces some previous-day tablemates back together.
    let pigeonhole = 0;
    tableSizes.forEach(function (k) {
      const q = Math.floor(k / T);
      const r = k % T;
      pigeonhole += r * comb2(q + 1) + (T - r) * comb2(q);
    });
    const Rbest = Math.max(M - comb2(N), comb2(D) * pigeonhole, 0);
    const repeatScore = Rworst <= Rbest ? 100 : clampScore((100 * (Rworst - R)) / (Rworst - Rbest));

    // Attribute spread.
    const attrScores = {};
    const attrDetail = {};
    activeAttrs.forEach(function (a) {
      const counts = {};
      for (let i = 0; i < N; i++) {
        const v = attrCodes[a][i];
        if (v >= 0) counts[v] = (counts[v] || 0) + 1;
      }
      const valueCounts = Object.keys(counts).map(function (k) { return counts[k]; });
      let actual = 0;
      daysOut.forEach(function (day) {
        day.tables.forEach(function (m) {
          for (let x = 0; x < m.length; x++) {
            for (let y = x + 1; y < m.length; y++) {
              const vx = attrCodes[a][m[x]];
              if (vx >= 0 && vx === attrCodes[a][m[y]]) actual++;
            }
          }
        });
      });
      const best = bestSamePairs(valueCounts, T) * D;
      const worst = worstSamePairs(valueCounts, tableSizes) * D;
      attrScores[a] = worst <= best ? 100 : clampScore((100 * (worst - actual)) / (worst - best));
      attrDetail[a] = { samePairs: actual, bestPossible: best, worstCase: worst };
    });

    // Gender balance (recomputed from output; structurally guaranteed ±1).
    let genderViolations = 0;
    daysOut.forEach(function (day) {
      classes.forEach(function (members, ci) {
        const fair = members.length / T;
        const lo = Math.floor(fair);
        const hi = Math.ceil(fair);
        day.tables.forEach(function (m) {
          const cnt = m.reduce(function (s, i) { return s + (classOf(i) === ci ? 1 : 0); }, 0);
          if (cnt < lo || cnt > hi) genderViolations++;
        });
      });
    });
    function classOf(i) {
      for (let ci = 0; ci < classes.length; ci++) {
        if (classes[ci].indexOf(i) >= 0) return ci;
      }
      return -1;
    }
    const genderScore = clampScore(100 - 20 * genderViolations);

    // Extra/unknown attrs get the same share as nationality (0.15), renormalised below.
    function shareFor(key) { return SCORE_SHARES[key] != null ? SCORE_SHARES[key] : 0.15; }

    // Weighted overall; criteria without data are excluded and shares renormalised.
    const parts = [{ key: 'repeat', score: repeatScore }];
    activeAttrs.forEach(function (a) { parts.push({ key: a, score: attrScores[a] }); });
    parts.push({ key: 'gender', score: genderScore });
    let shareSum = 0;
    parts.forEach(function (p) { shareSum += shareFor(p.key); });
    let overall = 0;
    parts.forEach(function (p) { overall += (shareFor(p.key) / shareSum) * p.score; });

    // Build components: all active attrs + null placeholders for inactive built-ins.
    const components = { repeat: Math.round(repeatScore) };
    activeAttrs.forEach(function (a) { components[a] = Math.round(attrScores[a]); });
    ATTRS.forEach(function (a) { if (components[a] == null) components[a] = null; });
    components.gender = Math.round(genderScore);

    return {
      overall: Math.round(overall),
      components: components,
      detail: {
        totalMeetings: M,
        uniquePairs: U,
        repeatedMeetings: R,
        theoreticalMinRepeats: Rbest,
        maxTimesAnyPairMet: maxMeet,
        repeatPairs: repeatPairs.slice(0, 20),
        attributes: attrDetail,
      },
    };
  }

  // ------------------------------------------------------ verification --
  // Independent re-check of the finished plan (recomputed from the output
  // itself, not from the construction) — this is what makes the result
  // trustworthy without manual re-checking.
  function verify(participants, daysOut, T) {
    const N = participants.length;
    const checks = [];

    // 1. Exactly once per day.
    let onceOk = true;
    let onceDetail = '';
    daysOut.forEach(function (day, d) {
      const seenCount = {};
      let total = 0;
      day.tables.forEach(function (m) {
        m.forEach(function (i) {
          seenCount[i] = (seenCount[i] || 0) + 1;
          total++;
        });
      });
      const missing = [];
      const dupes = [];
      for (let i = 0; i < N; i++) {
        if (!seenCount[i]) missing.push(participants[i].name);
        else if (seenCount[i] > 1) dupes.push(participants[i].name);
      }
      if (missing.length || dupes.length || total !== N) {
        onceOk = false;
        onceDetail += 'Day ' + (d + 1) + ': ' + (missing.length ? 'missing ' + missing.join(', ') + '. ' : '') + (dupes.length ? 'duplicated ' + dupes.join(', ') + '.' : '');
      }
    });
    checks.push({
      id: 'once',
      ok: onceOk,
      label: 'Every participant seated exactly once per day',
      detail: onceOk ? N + ' participants × ' + daysOut.length + ' day(s), no duplicates, no one missing' : onceDetail,
    });

    // 2. Table sizes balanced.
    let sizeOk = true;
    let minS = Infinity;
    let maxS = 0;
    daysOut.forEach(function (day) {
      day.tables.forEach(function (m) {
        minS = Math.min(minS, m.length);
        maxS = Math.max(maxS, m.length);
      });
    });
    sizeOk = maxS - minS <= 1 && Math.floor(N / T) === minS;
    checks.push({
      id: 'sizes',
      ok: sizeOk,
      label: 'Table sizes balanced (difference ≤ 1)',
      detail: 'Smallest table ' + minS + ', largest ' + maxS,
    });

    // 3. Gender balance per table.
    const byGender = {};
    participants.forEach(function (p, i) {
      (byGender[p.gender] = byGender[p.gender] || []).push(i);
    });
    let genderOk = true;
    let worstDev = 0;
    Object.keys(byGender).forEach(function (g) {
      const idxSet = {};
      byGender[g].forEach(function (i) { idxSet[i] = true; });
      const fair = byGender[g].length / T;
      daysOut.forEach(function (day) {
        day.tables.forEach(function (m) {
          const cnt = m.reduce(function (s, i) { return s + (idxSet[i] ? 1 : 0); }, 0);
          const dev = Math.max(Math.floor(fair) - cnt, cnt - Math.ceil(fair), 0);
          worstDev = Math.max(worstDev, dev);
          if (dev > 0) genderOk = false;
        });
      });
    });
    const genderSummary = Object.keys(byGender).map(function (g) { return g + ': ' + byGender[g].length; }).join(', ');
    checks.push({
      id: 'gender',
      ok: genderOk,
      label: 'Gender split per table as even as possible (±1)',
      detail: genderOk ? 'Cohort ' + genderSummary + ' — every table within ±1 of an even spread' : 'Worst deviation beyond ±1: ' + worstDev,
    });

    // 4. Repeat pairings (informational quality metric).
    const pairMeet = {};
    daysOut.forEach(function (day) {
      day.tables.forEach(function (m) {
        for (let x = 0; x < m.length; x++) {
          for (let y = x + 1; y < m.length; y++) {
            const key = Math.min(m[x], m[y]) + '_' + Math.max(m[x], m[y]);
            pairMeet[key] = (pairMeet[key] || 0) + 1;
          }
        }
      });
    });
    let twice = 0;
    let threePlus = 0;
    Object.keys(pairMeet).forEach(function (k) {
      if (pairMeet[k] === 2) twice++;
      if (pairMeet[k] >= 3) threePlus++;
    });
    checks.push({
      id: 'repeats',
      ok: threePlus === 0,
      label: 'Mixing across days',
      detail: twice === 0 && threePlus === 0 ? 'No pair of participants ever sits together twice' : twice + ' pair(s) meet twice, ' + threePlus + ' pair(s) meet 3+ times',
    });

    return { allHardChecksPass: onceOk && sizeOk && genderOk, checks: checks };
  }

  // ------------------------------------------------- workbook data prep --
  // Pure data (arrays of arrays) so the engine stays dependency-free;
  // the app layer turns these into a real .xlsx with SheetJS.
  function buildWorkbookSheets(participants, result, meta) {
    const D = result.days.length;
    const sheets = [];

    const s = result.score;
    const fmt = function (v) { return v == null ? 'n/a' : v + ' / 100'; };
    // Label map for score component rows: built-ins + extra attrs.
    const attrLabels = { coachingGroup: 'Coaching group', industry: 'Industry', nationality: 'Nationality' };
    (result.meta.extraAttrs || []).forEach(function (ea) { attrLabels[ea.key] = ea.label; });

    const summary = [
      ['Seating Group Generator — Summary'],
      [],
      ['Source file', meta.fileName || ''],
      ['Generated', meta.generatedAt || ''],
      ['Participants', result.meta.participants],
      ['Tables', result.meta.tables],
      ['Daily configurations', D],
      [],
      ['MIX SCORE', s.overall + ' / 100'],
      ['  Fresh pairings (repeat avoidance)', fmt(s.components.repeat)],
    ];
    result.meta.activeAttrs.forEach(function (a) {
      summary.push(['  ' + (attrLabels[a] || a) + ' spread', fmt(s.components[a])]);
    });
    summary.push(['  Gender balance', fmt(s.components.gender)]);
    summary.push([]);
    summary.push(['Verification (recomputed from this output)']);
    result.verification.checks.forEach(function (c) {
      summary.push([(c.ok ? 'PASS' : 'CHECK') + ' — ' + c.label, c.detail]);
    });
    summary.push([]);
    summary.push(['Pairs meeting more than once', String(s.detail.repeatedMeetings)]);
    summary.push(['Max times any pair sits together', String(s.detail.maxTimesAnyPairMet)]);
    sheets.push({ name: 'Summary', rows: summary });

    const extraCols = result.meta.extraAttrs || [];
    for (let d = 0; d < D; d++) {
      const header = ['Table', 'Name', 'Gender', 'Nationality', 'Industry', 'Coaching Group'];
      extraCols.forEach(function (ec) { header.push(ec.label); });
      const rows = [header];
      result.days[d].tables.forEach(function (members, t) {
        members.forEach(function (i) {
          const p = participants[i];
          const row = [t + 1, p.name, p.gender, p.nationality || '', p.industry || '', p.coachingGroup || ''];
          extraCols.forEach(function (ec) { row.push(p[ec.key] || ''); });
          rows.push(row);
        });
      });
      sheets.push({ name: 'Day ' + (d + 1), rows: rows });
    }

    const header = ['Name'];
    for (let d = 0; d < D; d++) header.push('Day ' + (d + 1));
    const byP = [header];
    participants
      .map(function (p, i) { return { name: p.name, i: i }; })
      .sort(function (a, b) { return a.name < b.name ? -1 : 1; })
      .forEach(function (e) {
        const row = [e.name];
        for (let d = 0; d < D; d++) row.push(result.days[d].tableOf[e.i] + 1);
        byP.push(row);
      });
    sheets.push({ name: 'By participant', rows: byP });

    return sheets;
  }

  return {
    parseParticipants: parseParticipants,
    generate: generate,
    verify: verify,
    buildWorkbookSheets: buildWorkbookSheets,
    FIELD_LABELS: FIELD_LABELS,
    DEFAULT_WEIGHTS: DEFAULT_WEIGHTS,
    _internals: { mulberry32: mulberry32, bestSamePairs: bestSamePairs, worstSamePairs: worstSamePairs },
  };
});
