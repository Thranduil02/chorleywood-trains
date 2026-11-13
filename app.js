/* Chorleywood Trains – UI, storage, sync and live data. Pure logic lives in core.js. */
(function () {
  'use strict';
  var C = window.Core, ID = C.ID;
  var TFL_DIRECT = 'https://api.tfl.gov.uk';
  var DEFAULT_BASE = 'https://chorleywood-trains.george-parish.workers.dev'; // Cloudflare Worker that holds the Rail Data Marketplace key
  var KEY = 'trains.store.v1';
  var BUILD = 'v27';
  var JP_GAP_MS = window.__JP_GAP_MS != null ? window.__JP_GAP_MS : 300; // the Worker adds a TfL app key (500 requests a minute)
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
  store.log = store.log || [];

  // Home stations. Each has its own stored timetables; Baker Street and Marylebone are shared.
  var STATIONS = {
    CLW: { key: 'CLW', name: 'Chorleywood', tube: ID.CYD, rail: ID.CLW_RAIL, crs: 'CLW',
      southbound: function (a) { return /southbound/i.test(a.platformName || '') || a.direction === 'outbound'; } },
    CFO: { key: 'CFO', name: 'Chalfont & Latimer', tube: ID.CAL, rail: ID.CFO_RAIL, crs: 'CFO',
      // trains that end here (the Chesham shuttle) never go to London, so keep them out of the matching
      southbound: function (a) { return (/southbound/i.test(a.platformName || '') || a.direction === 'outbound') && !/chalfont/i.test(a.destinationName || ''); } }
  };
  var STATION_KEYS = ['CLW', 'CFO'];
  if (!store.st) { // first run of the multi-station version: move the old single-station data under Chorleywood
    store.st = { CLW: { tfl: store.tfl, chiltern: store.chiltern || {}, syncTryAt: store.syncTryAt } };
    store.others = store.tfl && store.tfl.others; if (store.tfl) delete store.tfl.others;
    delete store.tfl; delete store.chiltern; delete store.syncTryAt;
  }
  if (!STATIONS[store.home]) store.home = 'CLW';
  function ST(k) { var o = store.st[k || store.home] = store.st[k || store.home] || {}; o.chiltern = o.chiltern || {}; return o; }
  function H() { return STATIONS[store.home]; }
  function otherKey() { return STATION_KEYS.filter(function (k) { return k !== store.home; })[0]; }
  function lk(name, k) { return (k || store.home) + ':' + name; } // live-reading slot for a station
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* storage full or blocked */ } }
  function log(msg) {
    store.log.push({ t: Date.now(), m: String(msg).slice(0, 300) });
    if (store.log.length > 40) store.log.splice(0, store.log.length - 40);
  }

  var LIVE_KEY = 'trains.live.v1';
  function loadLive() { // keep the last live readings across reloads, so platforms and delays don't vanish while the new fetch is in flight
    var out = {};
    try { var o = JSON.parse(localStorage.getItem(LIVE_KEY)) || {}; Object.keys(o).forEach(function (k) { if (o[k] && o[k].ok && Date.now() - o[k].at < 150000) out[k] = o[k]; }); } catch (e) { /* ignore */ }
    return out;
  }
  function saveLive() {
    try { var o = {}; Object.keys(S.live).forEach(function (k) { if (S.live[k] && S.live[k].ok) o[k] = S.live[k]; }); localStorage.setItem(LIVE_KEY, JSON.stringify(o)); } catch (e) { /* ignore */ }
  }
  var S = { live: {}, syncing: false, liveTried: false, view: 'london' };
  S.live = loadLive();

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function when(ts) {
    if (!ts) return 'never';
    var n = C.londonNow(ts), t = C.londonNow(Date.now());
    return (n.date === t.date ? 'today' : n.date.slice(8) + '/' + n.date.slice(5, 7)) + ' ' + C.fmt(n.minutes);
  }
  function fresh(x) { return !!(x && x.ok && Date.now() - x.at < 150000); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function getJson(url, ms, headers) {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, ms || 12000);
    return fetch(url, { signal: ctl.signal, cache: 'no-store', headers: headers || undefined }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).finally(function () { clearTimeout(to); });
  }
  function errText(e) { return e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || String(e); }
  // TfL calls go through the Worker (one shared key, short cache); if it can't answer, ask TfL directly.
  function tflJson(path, ms) {
    return getJson(DEFAULT_BASE + '/tfl' + path, ms).catch(function () { return getJson(TFL_DIRECT + path, ms); });
  }
  function countJ(tt) { return tt.schedules.reduce(function (n, s) { return n + s.j.length; }, 0); }

  /* ---------- timetable sync ---------- */
  function syncTfl(k) {
    var base = '/Line/metropolitan/Timetable/', stn = STATIONS[k], T = ST(k);
    return Promise.all([tflJson(base + stn.tube + '/to/' + ID.BST, 20000), tflJson(base + ID.BST + '/to/' + stn.tube, 20000)]).then(function (r) {
      var out = C.parseTimetable(r[0], ID.BST), back = C.parseTimetable(r[1], stn.tube);
      if (!countJ(out) || !countJ(back)) throw new Error('timetable had no usable trains (' + countJ(out) + '/' + countJ(back) + ')');
      var h = C.hash(JSON.stringify([out, back]));
      var prev = T.tfl, status = !prev || !prev.hash ? 'new' : (prev.hash === h ? 'same' : 'updated');
      T.tfl = {
        out: out, back: back, hash: h, fetchedAt: Date.now(), checkedAt: Date.now(), status: status, error: null,
        changedAt: status === 'same' ? prev.changedAt : Date.now()
      };
      log(stn.name + ' TfL timetable ' + status + ' (' + countJ(out) + ' + ' + countJ(back) + ' journeys)');
      if (store.others && Date.now() - store.others.at < 6 * 3600000) return null; // shared by both stations, no need to refetch often
      // Uxbridge and Watford departures from Baker Street, used only to tell unlabelled live predictions apart
      return Promise.all([tflJson(base + ID.BST + '/to/' + ID.UXB, 20000), tflJson(base + ID.BST + '/to/' + ID.WAF, 20000)]).then(function (o) {
        store.others = { U: C.parseBranch(o[0], ID.UXB), W: C.parseBranch(o[1], ID.WAF), at: Date.now() };
        log('Other branches stored (Uxbridge ' + store.others.U.reduce(function (n, x) { return n + x.d.length; }, 0) + ', Watford ' + store.others.W.reduce(function (n, x) { return n + x.d.length; }, 0) + ' departures)');
      }).catch(function (e) { log('Other branches failed: ' + errText(e)); });
    }).catch(function (e) {
      T.tfl = T.tfl || {};
      T.tfl.error = errText(e); T.tfl.status = T.tfl.out ? 'error' : 'none';
      log(stn.name + ' TfL timetable failed: ' + errText(e));
    });
  }

  function syncChilternDir(d, today, force, k) {
    var CH = ST(k).chiltern;
    var rec = CH[d.k] = CH[d.k] || { days: {} };
    Object.keys(rec.days).forEach(function (k) { if (k < C.dateAdd(today.date, -1)) delete rec.days[k]; });
    function getJ(ymd, hhmm) {
      var url = '/Journey/JourneyResults/' + d.from + '/to/' + d.to + '?mode=national-rail&date=' + ymd + '&time=' + hhmm + '&timeIs=Departing';
      var tries = 0;
      function go() {
        return tflJson(url, 15000).catch(function (e) {
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
        if (!C.windowMatches(C.flattenDays(rec.days), C.parseJourneys(j), nowStr)) { stale = true; log(k + ' Chiltern ' + d.k + ': near-term times differ from stored copy'); }
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
              log(k + ' Chiltern ' + d.k + ' ' + date + ': ' + trains.length + ' trains' + (day ? (day.hash === h ? ' (unchanged)' : ' (CHANGED)') : ''));
            }).catch(function (e) {
              // keep an older stored copy of a future day rather than failing the whole check
              log(k + ' Chiltern ' + d.k + ' ' + date + ' failed: ' + errText(e));
              if (!day || date === today.date) throw e;
            });
          });
        })(C.dateAdd(today.date, i));
      }
      return chain;
    });
    return step.then(function () { return { changed: changed, isNew: isNew }; });
  }

  function syncChiltern(k, force) {
    var today = C.londonNow(Date.now()), stn = STATIONS[k], CH = ST(k).chiltern;
    var dirs = [
      { k: 'toLondon', from: stn.rail, to: ID.MYB_RAIL },
      { k: 'toChorley', from: ID.MYB_RAIL, to: stn.rail }
    ];
    var changed = false, isNew = false, errors = [];
    return dirs.reduce(function (p, d) {
      return p.then(function () {
        return syncChilternDir(d, today, force, k).then(function (r) { changed = changed || r.changed; isNew = isNew || r.isNew; })
          .catch(function (e) { errors.push(d.k + ': ' + errText(e)); log(k + ' Chiltern ' + d.k + ' failed: ' + errText(e)); });
      });
    }, Promise.resolve()).then(function () {
      var have = CH.toLondon && Object.keys(CH.toLondon.days).length;
      CH.error = errors.length ? errors.join('; ') : null;
      if (!errors.length) {
        CH.checkedAt = Date.now();
        var prev = CH.status;
        CH.status = changed ? 'updated' : (!prev || prev === 'none' ? 'new' : (prev === 'updated' && Date.now() - (CH.changedAt || 0) < 864e5 ? 'updated' : 'same'));
        if (changed) CH.changedAt = Date.now();
      } else if (!have) CH.status = 'none';
      else CH.status = 'error';
    });
  }

  function syncAll(force) {
    if (S.syncing) return Promise.resolve();
    // don't re-run the whole check on every reload; the home station goes first, then the other one is kept ready for a quick switch
    var todo = [store.home, otherKey()].filter(function (k) {
      var T = ST(k), gap = T.tfl && T.tfl.out ? 10 * 60000 : 60000;
      return force || !T.syncTryAt || Date.now() - T.syncTryAt >= gap;
    });
    if (!todo.length) return Promise.resolve();
    todo.forEach(function (k) { ST(k).syncTryAt = Date.now(); });
    save();
    S.syncing = true; render();
    return todo.reduce(function (p, k) {
      return p.then(function () { return syncTfl(k); }).then(function () { save(); render(); return syncChiltern(k, !!force); }).then(function () { save(); render(); })
        .catch(function (e) { log(k + ' sync error: ' + errText(e)); save(); });
    }, Promise.resolve()).finally(function () { S.syncing = false; render(); });
  }

  /* ---------- live data ---------- */
  function liveTube(slot, stopId, filter, shiftMs) {
    return tflJson('/StopPoint/' + stopId + '/Arrivals', 10000).then(function (j) {
      var preds = C.parseArrivals(j, filter);
      if (shiftMs) preds.forEach(function (p) { p.t += shiftMs; }); // Baker Street: arrival time plus about a minute's dwell approximates departure
      var plats = {};
      preds.forEach(function (p) { plats[p.raw || '(none)'] = true; });
      var sample = (j || []).filter(function (a) { return a.lineId === 'metropolitan'; }).slice(0, 12).map(function (a) {
        return (filter(a) ? '* ' : '- ') + (a.destinationName || '?') + ' | ' + (a.towards || '?') + ' | ' + (a.platformName || '?') + ' | ' + (a.direction || '?') + ' | ' + C.fmt(C.londonNow(Date.parse(a.expectedArrival)).minutes) + ' | veh ' + (a.vehicleId || '?');
      });
      S.live[slot] = { ok: true, at: Date.now(), preds: preds, ms: preds.map(function (p) { return p.t; }), plats: Object.keys(plats), raw: (j || []).length, sample: sample };
    }).catch(function (e) {
      if (/HTTP 429/.test(errText(e))) S.backoffUntil = Date.now() + 60000;
      var prev = S.live[slot];
      // keep the last good reading (it goes stale by itself after 2.5 minutes) instead of dropping platforms on one failed fetch
      S.live[slot] = prev && prev.ok ? Object.assign({}, prev, { lastErr: errText(e) }) : { ok: false, at: Date.now(), err: errText(e) };
    });
  }
  function liveChiltern(slot, from, to, manual) {
    var prev = S.live[slot];
    var rq = C.liveBoardRequest(DEFAULT_BASE, '', from, to); // the built-in Worker holds the key
    if (!manual && prev && !prev.ok && Date.now() - prev.at < 300000) return Promise.resolve(); // back off after a failure
    return getJson(rq.url, 10000, rq.headers).then(function (j) {
      S.live[slot] = { ok: true, at: Date.now(), rows: C.parseDarwin(j, to), notices: C.parseNotices(j), raw: (j.trainServices || []).length };
    }).catch(function (e) {
      var m = errText(e);
      S.live[slot] = { ok: false, at: Date.now(), err: /HTTP (401|403)/.test(m) ? 'Key rejected (' + m + ')' : m };
    });
  }
  function refreshLive(manual) {
    if (!manual && S.backoffUntil && Date.now() < S.backoffUntil) return Promise.resolve(); // rate limited: wait out the minute
    S.liveTried = true;
    var h = H();
    return Promise.all([
      liveTube(lk('tube'), h.tube, h.southbound),
      liveTube('bst', ID.BST, C.bakerStreetNorthbound, 60000),
      liveChiltern(lk('toLondon'), h.crs, 'MYB', manual),
      liveChiltern(lk('toChorley'), 'MYB', h.crs, manual)
    ]).then(function () { saveLive(); render(); });
  }

  /* ---------- views ---------- */
  function statusPill() {
    var xs = [S.live[lk('tube')], S.live.bst, S.live[lk('toLondon')], S.live[lk('toChorley')]];
    var any = xs.some(fresh);
    if (any) {
      var t = Math.max.apply(null, xs.map(function (x) { return x ? x.at : 0; }));
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
    if (!toL) { // Marylebone to home: platforms matter, and are only known from the live board
      if (first.platform) pc = '<span class="chip ok" style="font-weight:700;color:#14161A">Platform ' + esc(first.platform) + '</span>';
      else if (first.live) pc = '<span class="small">Platform not announced yet</span>';
    }
    return c1 || pc ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + c1 + pc + '</div>' : '';
  }

  // Timetabled time stays as the headline; when the live time differs, "expected hh:mm" goes underneath.
  function expLine(sched, live, cls) {
    if (sched == null || live == null || C.fmt(live) === C.fmt(sched)) return '';
    return '<div class="' + (cls || 'sub') + ' late">expected ' + C.fmt(live) + '</div>';
  }

  function chilternCard(rows, toL, haveTT, syncing, noServiceToday) {
    var head = '<div class="row"><span class="tag ch">Chiltern Railways</span><span class="sub" style="margin:0">' + (toL ? 'to Marylebone' : 'to ' + esc(H().name)) + '</span></div>';
    var good = rows.filter(function (r) { return r.status !== 'cancelled'; });
    if (!good.length) {
      var msg = !haveTT ? (syncing ? 'Fetching the Chiltern timetable…' : 'No Chiltern timetable stored yet. Open the app once with a connection.') : (noServiceToday ? 'No Chiltern service found for today.' : 'No more Chiltern trains in the stored timetable.');
      var canc = rows.map(function (r) { return '<div class="small late">' + C.fmt(r.sched) + ' cancelled</div>'; }).join('');
      return '<section class="card" aria-label="Next Chiltern train">' + head + canc + '<div class="empty">' + msg + '</div></section>';
    }
    var first = good[0], second = good[1];
    function cline(r) { return '<div class="small late">' + C.fmt(r.sched) + ' cancelled</div>'; }
    var cancelled = rows.filter(function (r) { return r.status === 'cancelled' && r.sched <= first.sched; }).map(cline).join('');
    var between = rows.filter(function (r) { return r.status === 'cancelled' && r.sched > first.sched && (!second || r.sched < second.sched); }).map(cline).join('');
    var dest = first.dest && !toL ? 'to ' + esc(first.dest) : '';
    var plat = toL && first.platform ? 'Platform ' + esc(first.platform) : '';
    var line2 = [first.live ? '' : 'Timetable', dest, plat].filter(Boolean).join(' · ');
    var depExp = expLine(first.sched, first.dep), arrExp = expLine(first.schedArr, first.arr);
    var h = '<section class="card" aria-label="Next Chiltern train">' + head + cancelled +
      '<div class="row" style="align-items:flex-end"><div><div class="lbl">Departs</div><div class="big num">' + C.fmt(first.sched) + '</div>' + depExp +
      (line2 ? '<div class="sub">' + line2 + '</div>' : '') + '</div>' +
      '<div style="text-align:right"><div class="lbl">Arrives at ' + (toL ? 'Marylebone' : esc(H().name)) + '</div><div class="mid num">' + (first.schedArr != null ? C.fmt(first.schedArr) : (first.arr != null ? C.fmt(first.arr) : '–')) + '</div>' + arrExp + '</div></div>' +
      statusRow(first, toL);
    h += between;
    if (second) {
      var st2 = second.status === 'late' ? '<span class="small late">' + (second.delay && C.fmt(second.dep) !== C.fmt(second.sched) ? 'expected ' + C.fmt(second.dep) : 'Delayed') + '</span>' : '<span class="small">' + (second.live ? 'On time' : 'Timetable') + '</span>';
      h += '<div class="next"><span>Then <b class="num">' + C.fmt(second.sched) + '</b>' + (second.dest && !toL ? ' to ' + esc(second.dest) : '') + (!toL && second.platform ? ' · Platform ' + esc(second.platform) : '') + ' · arrives ' + (second.schedArr != null ? C.fmt(second.schedArr) : (second.arr != null ? C.fmt(second.arr) : '–')) + '</span>' + st2 + '</div>';
    }
    return h + '</section>';
  }

  var TYPE_LABEL = { fast: 'Fast', semi: 'Semi-fast', normal: 'Normal' };
  function tubeCard(rows, toL, haveTT, syncing) {
    var head = '<div class="row" style="padding-bottom:12px"><span class="tag met">Metropolitan line</span><span class="sub" style="margin:0">' + (toL ? 'to Baker Street' : 'to ' + esc(H().name)) + '</span></div>';
    var body = '';
    if (!rows.length) {
      body = '<div class="empty" style="padding:0 0 12px">' + (!haveTT ? (syncing ? 'Fetching the TfL timetable…' : 'No TfL timetable stored yet. Open the app once with a connection.') : 'No more Metropolitan line trains in the stored timetable.') + '</div>';
    }
    rows.forEach(function (r) {
      var to = C.NAME[r.last] || '';
      var skip = r.type === 'normal' ? '' : '<span class="small">' + esc(C.describeSkips(r.skipped)) + '</span>';
      var st = r.live ? (C.fmt(r.arr) !== C.fmt(r.schedArr) ? expLine(r.schedArr, r.arr, 'small') : '<div class="small">On time</div>') : '<div class="small">Timetable</div>';
      var plat = !toL && r.platform ? '<div class="small" style="font-weight:600;color:#14161A">Platform ' + esc(r.platform) + '</div>' : '';
      body += '<div class="tube"><div class="tc"><div class="t num">' + C.fmt(r.sched) + '</div>' + (r.live ? expLine(r.sched, r.dep, 'small') : '') + plat + '</div><div class="m"><span class="ty ' + r.type + '">' + TYPE_LABEL[r.type] + '</span>' +
        (to ? '<span class="sub" style="margin:0">to ' + esc(to) + '</span>' : '') + skip + '</div>' +
        '<div class="r"><div class="lbl">' + (toL ? 'Baker St' : esc(H().name)) + '</div><div class="a num">' + C.fmt(r.schedArr) + '</div>' + st + '</div></div>';
    });
    return '<section class="card" style="padding-bottom:4px" aria-label="Next three Metropolitan line trains">' + head + body + '</section>';
  }

  function footLink() {
    var o = STATIONS[otherKey()];
    return '<button class="link" type="button" data-act="switch" style="width:100%;border:0;font:inherit;font-weight:600;text-align:left;cursor:pointer;margin-bottom:10px;color:inherit">' +
      '<span style="display:flex;flex-direction:column;gap:1px;padding:8px 0"><span>Change home station</span>' +
      '<span class="small" style="font-family:-apple-system,system-ui,sans-serif;font-weight:400">' + esc(H().name) + ' \u2192 ' + esc(o.name) + '</span></span>' +
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#14161A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h9l-3-3M13 10H4l3 3"/></svg></button>' +
      '<a class="link" href="#data"><span>Data &amp; Sync Status</span><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#14161A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg></a>';
  }

  function viewMain(dir) {
    var now = C.londonNow(Date.now());
    var toL = dir === 'london', k = toL ? 'toLondon' : 'toChorley';
    var T = ST().tfl;
    var tt = T && (toL ? T.out : T.back);
    var tl = toL ? S.live[lk('tube')] : S.live.bst, cl = S.live[lk(k)];
    var oth = !toL && store.others;
    var others = oth ? { U: C.branchNear(oth.U, now, 360), W: C.branchNear(oth.W, now, 360) } : null;
    var preds = fresh(tl) ? tl.preds.filter(function (p) { return toL || others || p.cls === 'C'; }) // without the other branches, trust only labelled trains
      .map(function (p) { return { m: (p.t - now.midnightMs) / 60000, platform: p.platform, cls: p.cls || null }; }) : null;
    var tubes = tt ? C.nextTubes(tt, now, preds, 3, toL ? null : others) : [];
    var CH = ST().chiltern;
    var chT = CH[k] ? C.flattenDays(CH[k].days) : [];
    var chRows = C.chilternNext(chT, fresh(cl) ? cl.rows : null, now, 2);
    var rec = CH[k], dayRec = rec && rec.days && rec.days[now.date];
    var noToday = !!(dayRec && dayRec.trains && dayRec.trains.length === 0);
    var notices = [];
    ['toLondon', 'toChorley'].forEach(function (sl) {
      var x = S.live[lk(sl)];
      if (fresh(x) && x.notices) x.notices.forEach(function (t) { if (notices.indexOf(t) < 0) notices.push(t); });
    });
    var banner = notices.map(function (t) { return '<div class="banner"><b>Chiltern:</b> ' + esc(t) + '</div>'; }).join('');
    if (navigator.onLine === false) banner += '<div class="banner">No connection. Showing the stored timetable, so delays and cancellations won\'t appear.</div>';
    else if (cl && !cl.ok) banner += '<div class="banner">Chiltern live times unavailable (' + esc(cl.err) + '). Showing the timetable.</div>';
    else if (tl && !tl.ok) banner += '<div class="banner">TfL live times unavailable (' + esc(tl.err) + '). Showing the timetable.</div>';
    return '<div class="row"><h1 class="serif">' + (toL ? esc(H().name) : 'London') + '</h1>' + statusPill() + '</div>' +
      '<nav class="tabs" aria-label="Direction"><a href="#london"' + (toL ? ' aria-current="page"' : '') + '>To London</a><a href="#chorley"' + (!toL ? ' aria-current="page"' : '') + '>To ' + esc(H().name) + '</a></nav>' +
      banner + chilternCard(chRows, toL, chT.length > 0, S.syncing, noToday) + tubeCard(tubes, toL, !!tt, S.syncing) + footLink();
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
    L.push('build ' + BUILD + ' · home ' + H().name);
    L.push('now (London): ' + C.londonNow(Date.now()).date + ' ' + C.fmt(C.londonNow(Date.now()).minutes) + ' · online: ' + navigator.onLine);
    [lk('tube'), 'bst', lk('toLondon'), lk('toChorley')].forEach(function (k) {
      var x = S.live[k];
      L.push('live ' + k + ': ' + (!x ? 'not tried' : x.ok ? 'ok, ' + (x.ms ? x.ms.length + ' of ' + x.raw + ' predictions kept; platforms seen: ' + (x.plats.join(' | ') || 'none') : x.rows.length + ' services; platforms: ' + (x.rows.map(function (r) { return r.platform || '-'; }).join(',') || 'none')) : 'FAILED ' + x.err));
    });
    [lk('tube'), 'bst'].forEach(function (k) {
      var x = S.live[k]; if (x && x.sample && x.sample.length) L.push('\nraw Metropolitan arrivals ' + k + ' (* kept, - dropped)\n' + x.sample.join('\n'));
    });
    if (store.others) L.push('\nOther branches stored: Uxbridge ' + store.others.U.reduce(function (n, x) { return n + x.d.length; }, 0) + ' departures, Watford ' + store.others.W.reduce(function (n, x) { return n + x.d.length; }, 0));
    else L.push('\nOther branches: not stored yet');
    var T = ST().tfl;
    if (T && T.out) {
      [['to Baker Street', T.out], ['to ' + H().name, T.back]].forEach(function (p) {
        L.push('\nTfL patterns ' + p[0] + ' (' + countJ(p[1]) + ' journeys; schedules: ' + p[1].schedules.map(function (s) { return s.name + ' [' + s.days.join(',') + ']'; }).join(' | ') + ')');
        Object.keys(p[1].patterns).forEach(function (id) {
          var q = p[1].patterns[id];
          L.push(' ' + id + ' ' + q.type + ' · ' + C.describeSkips(q.skipped) + ' · ends ' + (C.NAME[q.last] || q.last) + ' · +' + q.off + ' min');
        });
      });
    }
    ['toLondon', 'toChorley'].forEach(function (k) {
      var r = ST().chiltern[k]; if (!r) return;
      L.push('\nChiltern ' + k + ': ' + Object.keys(r.days).sort().map(function (d) { return d + ' ' + r.days[d].trains.length; }).join(', '));
    });
    L.push('\nLog');
    store.log.slice(-25).forEach(function (e) { L.push(when(e.t) + ' ' + e.m); });
    return L.join('\n');
  }

  function viewData() {
    var t = ST().tfl || {}, c = ST().chiltern || {};
    var tubeL = S.live[lk('tube')];
    var nDays = c.toLondon ? Object.keys(c.toLondon.days).length : 0;
    return '<a class="back" href="#' + store.settings.tab + '"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#14161A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg>Back</a>' +
      '<h1 class="serif">Data &amp; Sync Status</h1>' +
      '<section class="list" aria-label="Live feeds"><h2>Live feeds</h2>' +
      liveRow('TfL', [tubeL, S.live.bst], tubeL && S.live.bst && tubeL.ok && S.live.bst.ok ? (tubeL.ms.length + S.live.bst.ms.length) + ' trains tracked' : '') +
      liveRow('Chiltern Railways', [S.live[lk('toLondon')], S.live[lk('toChorley')]]) + '</section>' +
      '<section class="list" aria-label="Stored timetables"><h2>Stored timetables \u00b7 ' + esc(H().name) + '</h2>' +
      '<div class="li"><div><div class="n">TfL Metropolitan line</div><div class="d">' + (t.fetchedAt ? 'Stored ' + when(t.fetchedAt) + ' · checked ' + when(t.checkedAt) : 'Nothing stored') + (t.error ? ' · ' + esc(t.error) : '') + '</div></div>' + sp(t.status) + '</div>' +
      '<div class="li"><div><div class="n">Chiltern Railways</div><div class="d">' + (c.checkedAt ? nDays + ' days stored · checked ' + when(c.checkedAt) : 'Nothing stored') + (c.error ? ' · ' + esc(c.error) : '') + '</div></div>' + sp(c.status) + '</div></section>' +
      '<section class="note"><b>How times are shown.</b> Online, each time is the live prediction, with the timetable time beneath it when they differ. Offline, you see the stored timetable only.</section>' +
      '<button class="btn" type="button" data-act="check"' + (S.syncing ? ' disabled' : '') + '>' + (S.syncing ? 'Checking…' : 'Check now') + '</button>' +
      '<details><summary>Diagnostics</summary><pre>' + esc(diagnostics()) + '</pre></details>' +
      '<section class="note">To install: in Safari tap Share, then Add to Home Screen. Open it once with a connection so the timetables can be stored.</section>' +
      '<button class="btn sec" type="button" data-act="reset">Clear stored data</button>' +
      '<div class="small" style="text-align:center;margin:12px 0">Build ' + BUILD + '</div>' +
      '<div class="small" style="text-align:center;margin:0 0 12px">Chorleywood Train Checker is a free app built by George Parish</div>';
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
    else if (a === 'switch') {
      store.home = otherKey(); save(); render();
      if (navigator.onLine !== false) { refreshLive(false); syncAll(false); }
    }
    else if (a === 'reset') {
      if (window.confirm('Clear the stored timetables? You will need a connection to fetch them again.')) {
        var keep = store.settings;
        store = { settings: keep, st: {}, home: store.home, log: [] }; save(); render();
        syncAll(true);
      }
    }
  });

  /* ---------- boot ---------- */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { render(); if (navigator.onLine !== false) refreshLive(false); }
  });
  window.addEventListener('online', function () { syncAll(false); refreshLive(false); });
  window.addEventListener('offline', render);
  setInterval(function () { if (document.visibilityState === 'visible') { render(); } }, 20000);
  setInterval(function () { if (document.visibilityState === 'visible' && navigator.onLine !== false) refreshLive(false); }, LIVE_EVERY_MS);

  route();
  if (navigator.onLine !== false) { syncAll(false); refreshLive(false); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* app still works without it */ });
  }
})();
