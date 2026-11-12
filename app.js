/* Chorleywood Trains – UI, storage, sync and live data. Pure logic lives in core.js. */
(function () {
  'use strict';
  var C = window.Core, ID = C.ID;
  var TFL = 'https://api.tfl.gov.uk';
  var DEFAULT_BASE = 'https://huxley2.azurewebsites.net';
  var KEY = 'trains.store.v1';
  var JP_GAP_MS = window.__JP_GAP_MS != null ? window.__JP_GAP_MS : 1600; // TfL allows roughly 50 anonymous requests a minute
  var DAYS_AHEAD = 2;               // Chiltern timetable stored for today + 2 days
  var RECHECK_MS = 24 * 3600 * 1000; // re-fetch each stored Chiltern day at least this often (near-term times are checked on every launch)
  var LIVE_EVERY_MS = 30000;

  /* ---------- storage ---------- */
  function load() {
    try { var s = JSON.parse(localStorage.getItem(KEY)); if (s && typeof s === 'object') return s; } catch (e) { /* ignore */ }
    return {};
  }
  var store = load();
  store.settings = store.settings || { token: '', base: '', tab: 'london' };
  store.chiltern = store.chiltern || {};
  store.log = store.log || [];
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* storage full or blocked */ } }
  function log(msg) {
    store.log.push({ t: Date.now(), m: String(msg).slice(0, 300) });
    if (store.log.length > 40) store.log.splice(0, store.log.length - 40);
  }

  var S = { live: {}, syncing: false, liveTried: false, view: 'london' };

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(ts) {
    if (!ts) return 'never';
    var n = C.londonNow(ts), t = C.londonNow(Date.now());
    return (n.date === t.date ? 'today' : n.date.slice(8) + '/' + n.date.slice(5, 7)) + ' ' + C.fmt(n.minutes);
  }
  function fresh(x) { return !!(x && x.ok && Date.now() - x.at < 150000); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function getJson(url, ms) {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, ms || 12000);
    return fetch(url, { signal: ctl.signal, cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).finally(function () { clearTimeout(to); });
  }
  function errText(e) { return e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || String(e); }
  function countJ(tt) { return tt.schedules.reduce(function (n, s) { return n + s.j.length; }, 0); }

  /* ---------- timetable sync ---------- */
  function syncTfl() {
    var base = TFL + '/Line/metropolitan/Timetable/';
    return Promise.all([getJson(base + ID.CYD + '/to/' + ID.BST, 20000), getJson(base + ID.BST + '/to/' + ID.CYD, 20000)]).then(function (r) {
      var out = C.parseTimetable(r[0], ID.BST), back = C.parseTimetable(r[1], ID.CYD);
      if (!countJ(out) || !countJ(back)) throw new Error('timetable had no usable trains (' + countJ(out) + '/' + countJ(back) + ')');
      var h = C.hash(JSON.stringify([out, back]));
      var prev = store.tfl, status = !prev || !prev.hash ? 'new' : (prev.hash === h ? 'same' : 'updated');
      store.tfl = {
        out: out, back: back, hash: h, fetchedAt: Date.now(), checkedAt: Date.now(), status: status, error: null,
        changedAt: status === 'same' ? prev.changedAt : Date.now()
      };
      log('TfL timetable ' + status + ' (' + countJ(out) + ' + ' + countJ(back) + ' journeys)');
    }).catch(function (e) {
      store.tfl = store.tfl || {};
      store.tfl.error = errText(e); store.tfl.status = store.tfl.out ? 'error' : 'none';
      log('TfL timetable failed: ' + errText(e));
    });
  }

  function syncChilternDir(d, today, force) {
    var rec = store.chiltern[d.k] = store.chiltern[d.k] || { days: {} };
    Object.keys(rec.days).forEach(function (k) { if (k < C.dateAdd(today.date, -1)) delete rec.days[k]; });
    function getJ(ymd, hhmm) {
      var url = TFL + '/Journey/JourneyResults/' + d.from + '/to/' + d.to + '?mode=national-rail&date=' + ymd + '&time=' + hhmm + '&timeIs=Departing';
      var tries = 0;
      function go() {
        return getJson(url, 15000).catch(function (e) {
          var m = /HTTP (\d+)/.exec((e && e.message) || '');
          if (m && m[1] === '404') return { journeys: [] }; // "no journey found" is an empty result, not a failure
          if (++tries > 3) throw e;
          return sleep(m && m[1] === '429' ? Math.max(30000 * (window.__JP_GAP_MS === 0 ? 0 : 1), 0) : tries * 1500).then(go); // rate limited: wait for the minute window to reset
        });
      }
      return go().then(function (j) { return sleep(JP_GAP_MS).then(function () { return j; }); });
    }
    var stale = false, changed = false, isNew = false;
    var step = Promise.resolve();
    if (!force && rec.days[today.date]) { // cheap check: does the next stretch of today still match what we stored?
      step = getJ(today.date.replace(/-/g, ''), C.pad(Math.floor(today.minutes / 60)) + C.pad(Math.floor(today.minutes % 60))).then(function (j) {
        var nowStr = today.date + 'T' + C.fmt(today.minutes);
        if (!C.windowMatches(C.flattenDays(rec.days), C.parseJourneys(j), nowStr)) { stale = true; log('Chiltern ' + d.k + ': near-term times differ from stored copy'); }
      });
    }
    step = step.then(function () {
      var chain = Promise.resolve();
      for (var i = 0; i <= DAYS_AHEAD; i++) {
        (function (date) {
          chain = chain.then(function () {
            var day = rec.days[date];
            var need = force || !day || Date.now() - day.fetchedAt > RECHECK_MS || (stale && date === today.date);
            if (!need) return null;
            return C.buildDay(getJ, date).then(function (trains) {
              if (!trains.length) throw new Error('no Chiltern trains returned for ' + date);
              var h = C.hash(JSON.stringify(trains));
              if (!day) isNew = true; else if (day.hash !== h) changed = true;
              rec.days[date] = { fetchedAt: Date.now(), hash: h, trains: trains };
              save(); // keep progress if iOS suspends the app mid-sync
              log('Chiltern ' + d.k + ' ' + date + ': ' + trains.length + ' trains' + (day ? (day.hash === h ? ' (unchanged)' : ' (CHANGED)') : ''));
            }).catch(function (e) {
              // keep an older stored copy of a future day rather than failing the whole check
              log('Chiltern ' + d.k + ' ' + date + ' failed: ' + errText(e));
              if (!day || date === today.date) throw e;
            });
          });
        })(C.dateAdd(today.date, i));
      }
      return chain;
    });
    return step.then(function () { return { changed: changed, isNew: isNew }; });
  }

  function syncChiltern(force) {
    var today = C.londonNow(Date.now());
    var dirs = [
      { k: 'toLondon', from: ID.CLW_RAIL, to: ID.MYB_RAIL },
      { k: 'toChorley', from: ID.MYB_RAIL, to: ID.CLW_RAIL }
    ];
    var changed = false, isNew = false, errors = [];
    return dirs.reduce(function (p, d) {
      return p.then(function () {
        return syncChilternDir(d, today, force).then(function (r) { changed = changed || r.changed; isNew = isNew || r.isNew; })
          .catch(function (e) { errors.push(d.k + ': ' + errText(e)); log('Chiltern ' + d.k + ' failed: ' + errText(e)); });
      });
    }, Promise.resolve()).then(function () {
      var have = store.chiltern.toLondon && Object.keys(store.chiltern.toLondon.days).length;
      store.chiltern.error = errors.length ? errors.join('; ') : null;
      if (!errors.length) {
        store.chiltern.checkedAt = Date.now();
        var prev = store.chiltern.status;
        store.chiltern.status = changed ? 'updated' : (!prev || prev === 'none' ? 'new' : (prev === 'updated' && Date.now() - (store.chiltern.changedAt || 0) < 864e5 ? 'updated' : 'same'));
        if (changed) store.chiltern.changedAt = Date.now();
      } else if (!have) store.chiltern.status = 'none';
      else store.chiltern.status = 'error';
    });
  }

  function syncAll(force) {
    if (S.syncing) return Promise.resolve();
    S.syncing = true; render();
    return syncTfl().then(function () { save(); render(); return syncChiltern(!!force); }).then(function () {
      save();
    }).catch(function (e) { log('sync error: ' + errText(e)); save(); }).finally(function () { S.syncing = false; render(); });
  }

  /* ---------- live data ---------- */
  function liveTube(slot, stopId, filter, shiftMs) {
    return getJson(TFL + '/StopPoint/' + stopId + '/Arrivals', 10000).then(function (j) {
      var preds = C.parseArrivals(j, filter);
      if (shiftMs) preds.forEach(function (p) { p.t += shiftMs; }); // Baker Street: arrival time plus about a minute's dwell approximates departure
      var plats = {};
      preds.forEach(function (p) { plats[p.raw || '(none)'] = true; });
      S.live[slot] = { ok: true, at: Date.now(), preds: preds, ms: preds.map(function (p) { return p.t; }), plats: Object.keys(plats), raw: (j || []).length };
    }).catch(function (e) { S.live[slot] = { ok: false, at: Date.now(), err: errText(e) }; });
  }
  function liveChiltern(slot, from, to, manual) {
    var prev = S.live[slot];
    if (!store.settings.token) { S.live[slot] = { ok: false, at: Date.now(), err: 'No National Rail token set' }; return Promise.resolve(); }
    if (!manual && prev && !prev.ok && Date.now() - prev.at < 300000) return Promise.resolve(); // back off after a failure
    var base = (store.settings.base || DEFAULT_BASE).replace(/\/+$/, '');
    var tok = store.settings.token ? '&accessToken=' + encodeURIComponent(store.settings.token) : '';
    return getJson(base + '/departures/' + from + '/to/' + to + '/8?expand=true' + tok, 10000).then(function (j) {
      S.live[slot] = { ok: true, at: Date.now(), rows: C.parseDarwin(j, to), raw: (j.trainServices || []).length };
    }).catch(function (e) { S.live[slot] = { ok: false, at: Date.now(), err: errText(e) }; });
  }
  function refreshLive(manual) {
    S.liveTried = true;
    return Promise.all([
      liveTube('cyd', ID.CYD, function (a) { return /southbound/i.test(a.platformName || '') || a.direction === 'outbound'; }),
      liveTube('bst', ID.BST, C.bakerStreetToChorleywood, 60000),
      liveChiltern('toLondon', 'CLW', 'MYB', manual),
      liveChiltern('toChorley', 'MYB', 'CLW', manual)
    ]).then(render);
  }

  /* ---------- views ---------- */
  function statusPill() {
    var a = S.live;
    var any = fresh(a.cyd) || fresh(a.bst) || fresh(a.toLondon) || fresh(a.toChorley);
    if (any) {
      var t = Math.max(a.cyd ? a.cyd.at : 0, a.bst ? a.bst.at : 0, a.toLondon ? a.toLondon.at : 0, a.toChorley ? a.toChorley.at : 0);
      return '<span class="pill live"><svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><circle cx="4" cy="4" r="4" fill="#0E3560"/></svg>Live · ' + C.fmt(C.londonNow(t).minutes) + '</span>';
    }
    if (navigator.onLine === false) return '<span class="pill off">Offline</span>';
    return '<span class="pill tt">' + (S.liveTried ? 'Timetable only' : 'Timetable') + '</span>';
  }

  function chip(status, delay, live) {
    if (status === 'cancelled') return '<span class="chip can">Cancelled</span>';
    if (status === 'late') return '<span class="chip late">' + (delay ? 'Delayed ' + delay + ' min' : 'Delayed') + '</span>';
    if (status === 'ontime') return '<span class="chip ok">On time</span>';
    return '';
  }

  function statusRow(first, toL) {
    var c1 = chip(first.status, first.delay, first.live);
    var pc = '';
    if (!toL) { // Marylebone to Chorleywood: platforms matter, and are only known from the live board
      if (first.platform) pc = '<span class="chip ok" style="font-weight:700;color:#14161A">Platform ' + esc(first.platform) + '</span>';
      else if (first.live) pc = '<span class="small">Platform not announced yet</span>';
    }
    return c1 || pc ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + c1 + pc + '</div>' : '';
  }

  function chilternCard(rows, toL, haveTT, syncing) {
    var head = '<div class="row"><span class="tag ch">Chiltern Railways</span><span class="sub" style="margin:0">' + (toL ? 'to Marylebone' : 'to Chorleywood') + '</span></div>';
    var good = rows.filter(function (r) { return r.status !== 'cancelled'; });
    if (!good.length) {
      var msg = !haveTT ? (syncing ? 'Fetching the Chiltern timetable…' : 'No Chiltern timetable stored yet. Open the app once with a connection.') : 'No more Chiltern trains in the stored timetable.';
      var canc = rows.map(function (r) { return '<div class="small late">' + C.fmt(r.sched) + ' cancelled</div>'; }).join('');
      return '<section class="card" aria-label="Next Chiltern train">' + head + canc + '<div class="empty">' + msg + '</div></section>';
    }
    var first = good[0], second = good[1];
    function cline(r) { return '<div class="small late">' + C.fmt(r.sched) + ' cancelled</div>'; }
    var cancelled = rows.filter(function (r) { return r.status === 'cancelled' && r.sched <= first.sched; }).map(cline).join('');
    var between = rows.filter(function (r) { return r.status === 'cancelled' && r.sched > first.sched && (!second || r.sched < second.sched); }).map(cline).join('');
    var dest = first.dest && !toL ? 'to ' + esc(first.dest) : '';
    var plat = toL && first.platform ? 'Platform ' + esc(first.platform) : '';
    var line2 = [first.status === 'late' || (first.live && first.sched !== first.dep) ? 'Timetable ' + C.fmt(first.sched) : (first.live ? '' : 'Timetable'), dest, plat].filter(Boolean).join(' · ');
    var arrSub = first.arr != null && first.schedArr != null && Math.round(first.arr) !== Math.round(first.schedArr) ? 'Timetable ' + C.fmt(first.schedArr) : '';
    var h = '<section class="card" aria-label="Next Chiltern train">' + head + cancelled +
      '<div class="row" style="align-items:flex-end"><div><div class="lbl">Departs</div><div class="big num">' + C.fmt(first.dep) + '</div>' +
      (line2 ? '<div class="sub">' + line2 + '</div>' : '') + '</div>' +
      '<div style="text-align:right"><div class="lbl">Arrives at ' + (toL ? 'Marylebone' : 'Chorleywood') + '</div><div class="mid num">' + (first.arr != null ? C.fmt(first.arr) : '–') + '</div>' +
      (arrSub ? '<div class="sub">' + arrSub + '</div>' : '') + '</div></div>' +
      statusRow(first, toL);
    h += between;
    if (second) {
      var st2 = second.status === 'late' ? '<span class="small late">' + (second.delay ? '+' + second.delay + ' min' : 'Delayed') + '</span>' : '<span class="small">' + (second.live ? 'On time' : 'Timetable') + '</span>';
      h += '<div class="next"><span>Then <b class="num">' + C.fmt(second.dep) + '</b>' + (second.dest && !toL ? ' to ' + esc(second.dest) : '') + (!toL && second.platform ? ' · Platform ' + esc(second.platform) : '') + ' · arrives ' + (second.arr != null ? C.fmt(second.arr) : '–') + '</span>' + st2 + '</div>';
    }
    return h + '</section>';
  }

  var TYPE_LABEL = { fast: 'Fast', semi: 'Semi-fast', normal: 'Normal' };
  function tubeCard(rows, toL, haveTT, syncing) {
    var head = '<div class="row" style="padding-bottom:12px"><span class="tag met">Metropolitan line</span><span class="sub" style="margin:0">' + (toL ? 'to Baker Street' : 'to Chorleywood') + '</span></div>';
    var body = '';
    if (!rows.length) {
      body = '<div class="empty" style="padding:0 0 12px">' + (!haveTT ? (syncing ? 'Fetching the TfL timetable…' : 'No TfL timetable stored yet. Open the app once with a connection.') : 'No more Metropolitan line trains in the stored timetable.') + '</div>';
    }
    rows.forEach(function (r) {
      var to = C.NAME[r.last] || '';
      var skip = r.type === 'normal' ? '' : '<span class="small">' + esc(C.describeSkips(r.skipped)) + '</span>';
      var st = r.live ? (r.delay > 0 ? '<div class="small late">+' + r.delay + ' min</div>' : '<div class="small">On time</div>') : '<div class="small">Timetable</div>';
      var plat = !toL && r.platform ? '<div class="small" style="font-weight:600;color:#14161A">Platform ' + esc(r.platform) + '</div>' : '';
      body += '<div class="tube"><div class="tc"><div class="t num">' + C.fmt(r.dep) + '</div>' + plat + '</div><div class="m"><span class="ty ' + r.type + '">' + TYPE_LABEL[r.type] + '</span>' +
        (to ? '<span class="sub" style="margin:0">to ' + esc(to) + '</span>' : '') + skip + '</div>' +
        '<div class="r"><div class="lbl">' + (toL ? 'Baker St' : 'Chorleywood') + '</div><div class="a num">' + C.fmt(r.arr) + '</div>' + st + '</div></div>';
    });
    return '<section class="card" style="padding-bottom:4px" aria-label="Next three Metropolitan line trains">' + head + body + '</section>';
  }

  function footLink() {
    return '<a class="link" href="#data"><span>Data &amp; Sync Status</span><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#14161A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg></a>';
  }

  function viewMain(dir) {
    var now = C.londonNow(Date.now());
    var toL = dir === 'london', k = toL ? 'toLondon' : 'toChorley';
    var tt = store.tfl && (toL ? store.tfl.out : store.tfl.back);
    var tl = toL ? S.live.cyd : S.live.bst, cl = S.live[k];
    var preds = fresh(tl) ? tl.preds.map(function (p) { return { m: (p.t - now.midnightMs) / 60000, platform: p.platform }; }) : null;
    var tubes = tt ? C.nextTubes(tt, now, preds, 3) : [];
    var chT = store.chiltern[k] ? C.flattenDays(store.chiltern[k].days) : [];
    var chRows = C.chilternNext(chT, fresh(cl) ? cl.rows : null, now, 2);
    var banner = '';
    if (navigator.onLine === false) banner = '<div class="banner">No connection. Showing the stored timetable, so delays and cancellations won\'t appear.</div>';
    else if (cl && !cl.ok && !store.settings.token) banner = '<div class="banner">Chiltern live times need a National Rail token. Add it under Data and sync; until then Chiltern times come from the timetable.</div>';
    else if (cl && !cl.ok) banner = '<div class="banner">Chiltern live times unavailable (' + esc(cl.err) + '). Showing the timetable.</div>';
    else if (tl && !tl.ok) banner = '<div class="banner">TfL live times unavailable (' + esc(tl.err) + '). Showing the timetable.</div>';
    return '<div class="row"><h1 class="serif">' + (toL ? 'Chorleywood' : 'London') + '</h1>' + statusPill() + '</div>' +
      '<nav class="tabs" aria-label="Direction"><a href="#london"' + (toL ? ' aria-current="page"' : '') + '>To London</a><a href="#chorley"' + (!toL ? ' aria-current="page"' : '') + '>To Chorleywood</a></nav>' +
      banner + chilternCard(chRows, toL, chT.length > 0, S.syncing) + tubeCard(tubes, toL, !!tt, S.syncing) + footLink();
  }

  var STATUS = { new: ['Stored', 'good'], same: ['Matches', 'good'], updated: ['Updated', 'good'], error: ['Check failed', 'bad'], none: ['Not stored', 'bad'] };
  function sp(s) { var x = STATUS[s || 'none'] || STATUS.none; return '<span class="chip ' + x[1] + '" style="white-space:nowrap">' + x[0] + '</span>'; }
  function liveRow(name, xs, extra) {
    var ok = xs.every(fresh);
    var bad = xs.filter(function (x) { return !(x && x.ok); })[0];
    var at = Math.max.apply(null, xs.map(function (x) { return x && x.ok ? x.at : 0; }));
    var detail;
    if (ok) detail = 'Updated ' + C.fmt(C.londonNow(at).minutes) + (extra ? ' \u00b7 ' + extra : '');
    else if (bad) detail = esc(bad.err);
    else if (xs.some(function (x) { return !x; })) detail = 'Not tried yet';
    else detail = 'Last update ' + C.fmt(C.londonNow(at).minutes) + ' is out of date';
    return '<div class="li"><div><div class="n">' + name + '</div><div class="d">' + detail + '</div></div><span class="chip ' + (ok ? 'good' : 'bad') + '" style="white-space:nowrap">' + (ok ? 'Connected' : 'Not connected') + '</span></div>';
  }
  function diagnostics() {
    var L = [];
    L.push('now (London): ' + C.londonNow(Date.now()).date + ' ' + C.fmt(C.londonNow(Date.now()).minutes) + ' · online: ' + navigator.onLine);
    ['cyd', 'bst', 'toLondon', 'toChorley'].forEach(function (k) {
      var x = S.live[k];
      L.push('live ' + k + ': ' + (!x ? 'not tried' : x.ok ? 'ok, ' + (x.ms ? x.ms.length + ' of ' + x.raw + ' predictions kept; platforms seen: ' + (x.plats.join(' | ') || 'none') : x.rows.length + ' services; platforms: ' + (x.rows.map(function (r) { return r.platform || '-'; }).join(',') || 'none')) : 'FAILED ' + x.err));
    });
    if (store.tfl && store.tfl.out) {
      [['to Baker Street', store.tfl.out], ['to Chorleywood', store.tfl.back]].forEach(function (p) {
        L.push('\nTfL patterns ' + p[0] + ' (' + countJ(p[1]) + ' journeys; schedules: ' + p[1].schedules.map(function (s) { return s.name + ' [' + s.days.join(',') + ']'; }).join(' | ') + ')');
        Object.keys(p[1].patterns).forEach(function (id) {
          var q = p[1].patterns[id];
          L.push(' ' + id + ' ' + q.type + ' · ' + C.describeSkips(q.skipped) + ' · ends ' + (C.NAME[q.last] || q.last) + ' · +' + q.off + ' min');
        });
      });
    }
    if (store.chiltern) ['toLondon', 'toChorley'].forEach(function (k) {
      var r = store.chiltern[k]; if (!r) return;
      L.push('\nChiltern ' + k + ': ' + Object.keys(r.days).sort().map(function (d) { return d + ' ' + r.days[d].trains.length; }).join(', '));
    });
    L.push('\nLog');
    store.log.slice(-25).forEach(function (e) { L.push(when(e.t) + ' ' + e.m); });
    return L.join('\n');
  }

  function viewData() {
    var t = store.tfl || {}, c = store.chiltern || {};
    var nDays = c.toLondon ? Object.keys(c.toLondon.days).length : 0;
    return '<a class="back" href="#' + store.settings.tab + '"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#14161A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>Back</a>' +
      '<h1 class="serif">Data &amp; Sync Status</h1>' +
      '<section class="list" aria-label="Live feeds"><h2>Live feeds</h2>' +
      liveRow('TfL', [S.live.cyd, S.live.bst], S.live.cyd && S.live.bst && S.live.cyd.ok && S.live.bst.ok ? (S.live.cyd.ms.length + S.live.bst.ms.length) + ' trains tracked' : '') +
      liveRow('Chiltern Railways', [S.live.toLondon, S.live.toChorley]) + '</section>' +
      '<section class="list" aria-label="Stored timetables"><h2>Stored timetables</h2>' +
      '<div class="li"><div><div class="n">TfL Metropolitan line</div><div class="d">' + (t.fetchedAt ? 'Stored ' + when(t.fetchedAt) + ' · checked ' + when(t.checkedAt) : 'Nothing stored') + (t.error ? ' · ' + esc(t.error) : '') + '</div></div>' + sp(t.status) + '</div>' +
      '<div class="li"><div><div class="n">Chiltern Railways</div><div class="d">' + (c.checkedAt ? nDays + ' days stored · checked ' + when(c.checkedAt) : 'Nothing stored') + (c.error ? ' · ' + esc(c.error) : '') + '</div></div>' + sp(c.status) + '</div></section>' +
      '<section class="note"><b>How times are shown.</b> Online, each time is the live prediction, with the timetable time beneath it when they differ. Offline, you see the stored timetable only.</section>' +
      '<button class="btn" type="button" data-act="check"' + (S.syncing ? ' disabled' : '') + '>' + (S.syncing ? 'Checking…' : 'Check now') + '</button>' +
      '<section class="list" aria-label="Settings"><h2>National Rail live token</h2>' +
      '<div class="field"><label for="tok">Darwin access token</label><input id="tok" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" value="' + esc(store.settings.token) + '"></div>' +
      '<div class="field"><label for="base">Live service address (optional)</label><input id="base" type="url" autocapitalize="off" spellcheck="false" placeholder="' + DEFAULT_BASE + '" value="' + esc(store.settings.base) + '"></div>' +
      '<div class="field"><button class="btn sec" type="button" data-act="save">Save and refresh live data</button></div></section>' +
      '<details><summary>Diagnostics</summary><pre>' + esc(diagnostics()) + '</pre></details>' +
      '<section class="note">To install: in Safari tap Share, then Add to Home Screen. Open it once with a connection so the timetables can be stored.</section>' +
      '<button class="btn sec" type="button" data-act="reset">Clear stored data</button>';
  }

  var appEl = document.getElementById('app');
  function render() {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return; // don't wipe a field mid-typing
    var scroll = window.scrollY;
    appEl.innerHTML = S.view === 'data' ? viewData() : viewMain(S.view);
    window.scrollTo(0, scroll);
  }

  /* ---------- routing and events ---------- */
  function route() {
    var h = location.hash.replace('#', '');
    if (h === 'london' || h === 'chorley') { S.view = h; store.settings.tab = h; save(); }
    else if (h === 'data') S.view = 'data';
    else S.view = store.settings.tab === 'chorley' ? 'chorley' : 'london';
    render();
    if (S.view === 'data') window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el) return;
    var a = el.getAttribute('data-act');
    if (a === 'check') { refreshLive(true); syncAll(true); }
    else if (a === 'save') {
      store.settings.token = document.getElementById('tok').value.trim();
      store.settings.base = document.getElementById('base').value.trim();
      save(); document.activeElement.blur(); S.live.toLondon = S.live.toChorley = null;
      refreshLive(true);
    } else if (a === 'reset') {
      if (window.confirm('Clear the stored timetables? You will need a connection to fetch them again.')) {
        var keep = store.settings;
        store = { settings: keep, chiltern: {}, log: [] }; save(); render();
        syncAll(true);
      }
    }
  });

  /* ---------- boot ---------- */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { render(); if (navigator.onLine !== false) refreshLive(false); }
  });
  window.addEventListener('online', function () { syncAll(false); refreshLive(true); });
  window.addEventListener('offline', render);
  setInterval(function () { if (document.visibilityState === 'visible') { render(); } }, 20000);
  setInterval(function () { if (document.visibilityState === 'visible' && navigator.onLine !== false) refreshLive(false); }, LIVE_EVERY_MS);

  route();
  if (navigator.onLine !== false) { syncAll(false); refreshLive(false); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* app still works without it */ });
  }
})();
