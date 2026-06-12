/*
 * app.js — UI layer for the Seating Group Generator.
 * Everything runs locally in the browser: file parsing (SheetJS), the
 * deterministic engine (mixer.js) and the Excel download. No network calls.
 */
(function () {
  'use strict';

  var state = {
    fileName: null,
    participants: [],
    warnings: [],
    result: null,
  };

  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------ helpers --
  function show(el, on) { el.classList.toggle('hidden', !on); }

  function setStatus(html, kind) {
    var box = $('parse-status');
    box.innerHTML = html;
    box.className = 'status ' + (kind || '');
    show(box, true);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // -------------------------------------------------------- file intake --
  function handleFile(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        ingestRows(rows, file.name);
      } catch (err) {
        setStatus('Could not read this file as Excel/CSV: ' + esc(err.message), 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function ingestRows(rows, fileName) {
    var parsed = Mixer.parseParticipants(rows);
    if (parsed.errors.length) {
      setStatus('<strong>Could not use this file.</strong><br>' + parsed.errors.map(esc).join('<br>'), 'error');
      state.participants = [];
      refreshSteps();
      return;
    }
    state.fileName = fileName;
    state.participants = parsed.participants;
    state.warnings = parsed.warnings;
    state.result = null;

    var n = parsed.participants.length;
    var genders = {};
    parsed.participants.forEach(function (p) { genders[p.gender] = (genders[p.gender] || 0) + 1; });
    var genderTxt = Object.keys(genders).sort().map(function (g) { return genders[g] + ' ' + esc(g); }).join(' · ');

    var mapped = Object.keys(parsed.columnMap).map(function (f) { return Mixer.FIELD_LABELS[f]; }).join(', ');
    var html = '<strong>' + esc(fileName) + '</strong> — ' + n + ' participants loaded (' + genderTxt + ').<br>' +
      '<span class="muted">Columns recognised: ' + esc(mapped) + '</span>';
    if (parsed.warnings.length) {
      html += '<br><span class="warn-text">⚠ ' + parsed.warnings.map(esc).join('<br>⚠ ') + '</span>';
    }
    setStatus(html, 'ok');

    // Sensible defaults: ~6 people per table.
    if (!$('inp-tables').value) $('inp-tables').value = Math.max(2, Math.round(n / 6));
    refreshSteps();
    show($('results'), false);
  }

  function refreshSteps() {
    var ready = state.participants.length > 0;
    $('step-2').classList.toggle('disabled', !ready);
    $('step-3').classList.toggle('disabled', !ready);
    $('btn-generate').disabled = !ready;
  }

  // ----------------------------------------------------------- generate --
  function generate() {
    var T = parseInt($('inp-tables').value, 10);
    var D = parseInt($('inp-days').value, 10);
    var box = $('gen-status');
    box.className = 'status';
    box.textContent = 'Generating… (deterministic optimisation, runs entirely in your browser)';
    show(box, true);
    $('btn-generate').disabled = true;

    // Let the spinner paint before the (CPU-bound) optimisation starts.
    setTimeout(function () {
      try {
        // Future: pass custom weights here, e.g. {weights:{coachingGroup:6}}
        // to make coaching-group variety dominate. UI deliberately not built yet.
        var result = Mixer.generate(state.participants, { tables: T, days: D });
        state.result = result;
        show(box, false);
        renderResults(result);
      } catch (err) {
        box.textContent = err.message;
        box.className = 'status error';
      }
      $('btn-generate').disabled = false;
    }, 30);
  }

  // ------------------------------------------------------------ results --
  function renderResults(r) {
    show($('results'), true);

    // Score ring.
    var ring = $('score-ring');
    var circumference = 2 * Math.PI * 52;
    ring.style.strokeDasharray = circumference;
    ring.style.strokeDashoffset = circumference * (1 - r.score.overall / 100);
    $('score-number').textContent = r.score.overall;

    var d = r.score.detail;
    var msg;
    if (d.repeatedMeetings === 0) {
      msg = 'No two participants ever sit together twice.';
    } else if (d.theoreticalMinRepeats > 0) {
      msg = d.repeatedMeetings + ' repeat pairings across ' + r.days.length + ' days — the theoretical minimum for this group/table size is ' + d.theoreticalMinRepeats + '.';
    } else {
      msg = d.repeatedMeetings + ' repeat pairings across ' + r.days.length + ' days; no pair meets ' + (d.maxTimesAnyPairMet + 1) + '+ times.';
    }
    $('score-caption').textContent = msg;

    // Component bars.
    var labels = {
      repeat: 'Fresh pairings',
      coachingGroup: 'Coaching group spread',
      industry: 'Industry spread',
      nationality: 'Nationality spread',
      gender: 'Gender balance',
    };
    var bars = '';
    Object.keys(labels).forEach(function (k) {
      var v = r.score.components[k];
      if (v == null) return;
      bars += '<div class="bar-row"><span class="bar-label">' + labels[k] + '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + v + '%"></div></div>' +
        '<span class="bar-value">' + v + '</span></div>';
    });
    $('score-bars').innerHTML = bars;

    // Verification checklist.
    var checks = '';
    r.verification.checks.forEach(function (c) {
      checks += '<li class="' + (c.ok ? 'check-ok' : 'check-warn') + '">' +
        '<span class="check-icon">' + (c.ok ? '✓' : '!') + '</span>' +
        '<div><strong>' + esc(c.label) + '</strong><br><span class="muted">' + esc(c.detail) + '</span></div></li>';
    });
    $('verify-list').innerHTML = checks;

    // Day tabs.
    var tabs = '';
    for (var i = 0; i < r.days.length; i++) {
      tabs += '<button class="tab' + (i === 0 ? ' active' : '') + '" data-day="' + i + '">Day ' + (i + 1) + '</button>';
    }
    $('day-tabs').innerHTML = tabs;
    Array.prototype.forEach.call($('day-tabs').children, function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call($('day-tabs').children, function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        renderDay(parseInt(btn.getAttribute('data-day'), 10));
      });
    });
    renderDay(0);

    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderDay(dayIdx) {
    var r = state.result;
    var html = '';
    r.days[dayIdx].tables.forEach(function (members, t) {
      html += '<div class="table-card"><div class="table-card-head">Table ' + (t + 1) +
        ' <span class="muted">· ' + members.length + ' people</span></div><ul>';
      members.forEach(function (i) {
        var p = state.participants[i];
        var meta = [p.gender, p.nationality, p.industry, p.coachingGroup].filter(Boolean).join(' · ');
        html += '<li><strong>' + esc(p.name) + '</strong><span class="muted member-meta">' + esc(meta) + '</span></li>';
      });
      html += '</ul></div>';
    });
    $('day-grid').innerHTML = html;
  }

  // ----------------------------------------------------------- download --
  function downloadResult() {
    var r = state.result;
    if (!r) return;
    var sheets = Mixer.buildWorkbookSheets(state.participants, r, {
      fileName: state.fileName,
      generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
    var wb = XLSX.utils.book_new();
    sheets.forEach(function (s) {
      var ws = XLSX.utils.aoa_to_sheet(s.rows);
      if (s.name === 'Summary') {
        ws['!cols'] = [{ wch: 46 }, { wch: 50 }];
      } else if (s.name === 'By participant') {
        ws['!cols'] = [{ wch: 26 }].concat(s.rows[0].slice(1).map(function () { return { wch: 8 }; }));
      } else {
        ws['!cols'] = [{ wch: 7 }, { wch: 26 }, { wch: 8 }, { wch: 16 }, { wch: 20 }, { wch: 16 }];
      }
      XLSX.utils.book_append_sheet(wb, ws, s.name);
    });
    var base = (state.fileName || 'participants').replace(/\.[^.]+$/, '');
    XLSX.writeFile(wb, 'Seating_' + base + '_' + r.meta.tables + 'tables_' + r.meta.days + 'days.xlsx');
  }

  function downloadTemplate() {
    var rows = [
      ['Name', 'Industry', 'Gender', 'Nationality', 'Coaching Group'],
      ['Maria Example', 'Finance', 'F', 'Spain', 'A'],
      ['Ken Example', 'Technology', 'M', 'Japan', 'B'],
    ];
    var wb = XLSX.utils.book_new();
    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [{ wch: 26 }, { wch: 20 }, { wch: 8 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Participants');
    XLSX.writeFile(wb, 'participant_template.xlsx');
  }

  function loadSample() {
    var wb = XLSX.read(window.SAMPLE_CSV, { type: 'string' });
    var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
    ingestRows(rows, 'sample_cohort_48.csv');
  }

  // ------------------------------------------------------------- wiring --
  document.addEventListener('DOMContentLoaded', function () {
    var drop = $('dropzone');
    var input = $('file-input');

    drop.addEventListener('click', function () { input.click(); });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('drag'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.classList.remove('drag');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', function () {
      if (input.files.length) handleFile(input.files[0]);
      input.value = '';
    });

    $('btn-template').addEventListener('click', downloadTemplate);
    $('btn-sample').addEventListener('click', loadSample);
    $('btn-generate').addEventListener('click', generate);
    $('btn-download').addEventListener('click', downloadResult);

    refreshSteps();
  });
})();
