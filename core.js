/* Chorleywood Trains – pure logic (no DOM, no network). Shared by the app and the Node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ID = {
    CYD: '940GZZLUCYD', BST: '940GZZLUBST',
    CLW_RAIL: '910GCHRW', MYB_RAIL: '910GMARYLBN'
  };

  // Stations between Moor Park and Harrow-on-the-Hill (MID) and between Harrow and Finchley Road (INNER).
  var MID = ['940GZZLUNOW', '940GZZLUNWH', '940GZZLUPNR', '940GZZLUNHA'];
  var INNER = ['940GZZLUNKP', '940GZZLUPRD', '940GZZLUWYP'];
  var NAME = {
    '940GZZLUCYD': 'Chorleywood', '940GZZLURKW': 'Rickmansworth', '940GZZLUMPK': 'Moor Park',
    '940GZZLUNOW': 'Northwood', '940GZZLUNWH': 'Northwood Hills', '940GZZLUPNR': 'Pinner',
    '940GZZLUNHA': 'North Harrow', '940GZZLUHOH': 'Harrow-on-the-Hill', '940GZZLUNKP': 'Northwick Park',
    '940GZZLUPRD': 'Preston Road', '940GZZLUWYP': 'Wembley Park', '940GZZLUFYR': 'Finchley Road',
    '940GZZLUBST': 'Baker Street', '940GZZLUALD': 'Aldgate', '940GZZLUAMS': 'Amersham',
    '940GZZLUCSM': 'Chesham', '940GZZLUCAL': 'Chalfont & Latimer', '940GZZLUWAF': 'Watford',
    '940GZZLUUXB': 'Uxbridge', '940GZZLUCXY': 'Croxley'
  };

  /* ---------- small helpers ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(s) { var m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function fmt(absMin) {
    var m = ((Math.floor(absMin + 1e-9) % 1440) + 1440) % 1440;
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }
  function hash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    var s = h.toString(16);
    return '00000000'.slice(s.length) + s;
  }
  function dateAdd(ds, n) {
    var p = ds.split('-').map(Number);
    var t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }
  function dayDiff(a, b) {
    var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    return Math.round((Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / 86400000);
  }
  // 'YYYY-MM-DDTHH:mm...' -> minutes since midnight of baseDate (may exceed 1440 or be negative)
  function absFromLocal(str, baseDate) {
    return dayDiff(str.slice(0, 10), baseDate) * 1440 + (+str.slice(11, 13)) * 60 + (+str.slice(14, 16));
  }
  var WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  function londonNow(ms) {
    var f = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false
    });
    var p = {};
    f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    var minutes = ((+p.hour) % 24) * 60 + (+p.minute) + (+p.second) / 60;
    return {
      ms: ms, date: p.year + '-' + p.month + '-' + p.day, dow: WD[p.weekday.slice(0, 3)],
      minutes: minutes, midnightMs: ms - minutes * 60000
    };
  }

  /* ---------- Metropolitan line: stopping pattern -> fast / semi-fast / normal ---------- */
  // fast      : misses at least 3 of Northwood, Northwood Hills, Pinner, North Harrow (a stop at Wembley Park does not matter)
  // semi-fast : calls at those, but misses one or more of the stations between Harrow-on-the-Hill and Finchley Road
  // normal    : calls at every station
  function classify(stopsBeforeDest) {
    var set = {};
    stopsBeforeDest.forEach(function (s) { set[s] = true; });
    var midSkipped = MID.filter(function (s) { return !set[s]; });
    var innerSkipped = INNER.filter(function (s) { return !set[s]; });
    var type = 'normal';
    if (midSkipped.length >= 3) type = 'fast';
    else if (midSkipped.length + innerSkipped.length > 0) type = 'semi';
    return { type: type, skipped: midSkipped.concat(innerSkipped) };
  }
  function describeSkips(sk) {
    if (!sk || !sk.length) return 'Calls at every station';
    var set = {}, parts = [];
    sk.forEach(function (s) { set[s] = true; });
    if (MID.every(function (s) { return set[s]; })) parts.push('Northwood\u2013North Harrow');
    else MID.filter(function (s) { return set[s]; }).forEach(function (s) { parts.push(NAME[s]); });
    if (INNER.every(function (s) { return set[s]; })) parts.push('Northwick Park\u2013Wembley Park');
    else INNER.filter(function (s) { return set[s]; }).forEach(function (s) { parts.push(NAME[s]); });
    return 'Skips ' + parts.join(', ');
  }

  var D3 = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  function parseDays(name) {
    var n = String(name || '').toLowerCase();
    var hits = [];
    D3.forEach(function (d, i) {
      var m = new RegExp('\\b' + d + '[a-z]*').exec(n);
      if (m) hits.push({ i: i, pos: m.index, end: m.index + m[0].length });
    });
    hits.sort(function (a, b) { return a.pos - b.pos; });
    if (!hits.length) return [];
    if (hits.length === 2) {
      var between = n.slice(hits[0].end, hits[1].pos);
      if (/[-–—]|\bto\b|\bthrough\b/.test(between) && !/\band\b|&|,/.test(between)) {
        var out = [], d = hits[0].i;
        for (var k = 0; k < 7; k++) { out.push(d); if (d === hits[1].i) break; d = (d + 1) % 7; }
        return out;
      }
    }
    return hits.map(function (h) { return h.i; });
  }

  // Compact a TfL /Line/{id}/Timetable/{from}/to/{to} response for one direction.
  function parseTimetable(json, destStopId) {
    var tt = (json && json.timetable) || json || {};
    var out = { v: 1, dep: tt.departureStopId || null, dest: destStopId, patterns: {}, schedules: [] };
    (tt.routes || []).forEach(function (route, ri) {
      var iv = {};
      (route.stationIntervals || []).forEach(function (si) { iv[String(si.id)] = si.intervals || []; });
      (route.schedules || []).forEach(function (sch) {
        var js = [], seen = {};
        (sch.knownJourneys || []).forEach(function (kj) {
          var ivs = iv[String(kj.intervalId)];
          if (!ivs) return;
          var idx = -1;
          for (var i = 0; i < ivs.length; i++) if (ivs[i].stopId === destStopId) { idx = i; break; }
          if (idx < 0) return; // this train does not go to our destination
          var pid = ri + '_' + kj.intervalId;
          if (!out.patterns[pid]) {
            var before = ivs.slice(0, idx).map(function (x) { return x.stopId; });
            var c = classify(before);
            out.patterns[pid] = {
              type: c.type, skipped: c.skipped, off: Number(ivs[idx].timeToArrival),
              last: ivs[ivs.length - 1].stopId
            };
          }
          var dep = (+kj.hour) * 60 + (+kj.minute);
          var key = dep + '|' + pid;
          if (seen[key]) return;
          seen[key] = true;
          js.push([dep, pid]);
        });
        js.sort(function (a, b) { return a[0] - b[0]; });
        out.schedules.push({ name: sch.name, days: parseDays(sch.name), j: js });
      });
    });
    return out;
  }

  function tubeCandidates(tt, now, horizon) {
    var res = [];
    if (!tt) return res;
    [-1, 0].forEach(function (shift) {
      var dow = (now.dow + 7 + shift) % 7;
      tt.schedules.forEach(function (s) {
        if (s.days.indexOf(dow) < 0) return;
        s.j.forEach(function (x) {
          var dep = x[0];
          var abs = (dep < 180 ? dep + 1440 : dep) + shift * 1440; // 00:00-02:59 belongs to the previous day's service
          if (abs < now.minutes - 15 || abs > now.minutes + horizon) return;
          var p = tt.patterns[x[1]];
          res.push({
            sched: abs, dep: abs, schedArr: abs + p.off, arr: abs + p.off,
            type: p.type, skipped: p.skipped, last: p.last, live: false, delay: 0
          });
        });
      });
    });
    res.sort(function (a, b) { return a.sched - b.sched; });
    return res;
  }

  // Order-preserving match of live predictions (minutes) to scheduled departures.
  function matchLive(cands, preds) {
    var p = preds.map(function (x) { return typeof x === 'number' ? { m: x, platform: null } : x; })
      .sort(function (a, b) { return a.m - b.m; });
    var usedP = {}, i, j;
    // pass 1: near-exact matches
    cands.forEach(function (c) {
      var best = -1, bd = 1e9;
      for (j = 0; j < p.length; j++) {
        if (usedP[j]) continue;
        var d = Math.abs(p[j].m - c.sched);
        if (d <= 1.5 && d < bd) { bd = d; best = j; }
      }
      if (best >= 0) { usedP[best] = true; c.liveDep = p[best].m; c.platform = p[best].platform; }
    });
    // pass 2: delayed trains, order preserving, only trains not yet due
    var rc = cands.filter(function (c) { return c.liveDep == null; });
    var rp = p.filter(function (v, k) { return !usedP[k]; });
    i = 0; j = 0;
    while (i < rc.length && j < rp.length) {
      var d2 = rp[j].m - rc[i].sched;
      if (d2 >= -2 && d2 <= 20) { rc[i].liveDep = rp[j].m; rc[i].platform = rp[j].platform; i++; j++; }
      else if (d2 < -2) j++;
      else i++;
    }
  }

  function nextTubes(tt, now, predMinutes, count) {
    var cands = tubeCandidates(tt, now, 360);
    var haveLive = !!(predMinutes && predMinutes.length);
    if (haveLive) matchLive(cands.filter(function (c) { return c.sched >= now.minutes - 3; }), predMinutes);
    cands.forEach(function (c) {
      if (c.liveDep != null) {
        c.live = true;
        c.delay = Math.round(c.liveDep - c.sched);
        c.dep = c.sched + c.delay;
        c.arr = c.schedArr + c.delay;
      }
    });
    return cands.filter(function (c) { return c.dep >= now.minutes - 0.5; })
      .sort(function (a, b) { return a.dep - b.dep; }).slice(0, count);
  }

  function parseArrivals(json, filterFn) {
    var out = [];
    (json || []).forEach(function (a) {
      if (a.lineId !== 'metropolitan') return;
      if (filterFn && !filterFn(a)) return;
      var t = Date.parse(a.expectedArrival);
      var pm = /platform\s*([0-9]+[a-z]?)/i.exec(a.platformName || '');
      if (!isNaN(t)) out.push({ t: t, platform: pm ? pm[1] : null, raw: a.platformName || '', vid: a.vehicleId || null });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    var seen = {}; // TfL can list one vehicle twice with different platforms: keep its earliest prediction
    return out.filter(function (x) { if (!x.vid) return true; if (seen[x.vid]) return false; seen[x.vid] = true; return true; });
  }
  // Baker Street: only trust a prediction once TfL has labelled it Amersham or Chesham. Unlabelled and "Baker Street"
  // predictions turn out to be Uxbridge, Watford or terminating trains (vehicle 433 was blank 26 minutes out, then Uxbridge).
  function bakerStreetToChorleywood(a) {
    return /amersham|chesham/i.test((a.destinationName || '') + ' ' + (a.towards || ''));
  }

  /* ---------- Chiltern ---------- */
  function parseJourneys(json) {
    var res = [];
    ((json && json.journeys) || []).forEach(function (j) {
      var legs = j.legs || [];
      if (legs.length !== 1) return;
      if (JSON.stringify(legs[0]).toLowerCase().indexOf('chiltern') < 0) return;
      var dep = String(j.startDateTime || legs[0].departureTime || '').slice(0, 16);
      var arr = String(j.arrivalDateTime || legs[0].arrivalTime || '').slice(0, 16);
      if (dep.length === 16 && arr.length === 16) res.push({ dep: dep, arr: arr });
    });
    return res;
  }

  // Walk through a service day using repeated journey-planner calls. getJ(yyyymmdd, hhmm) -> JSON.
  function buildDay(getJ, dateStr, maxCalls) {
    maxCalls = maxCalls || 40;
    var trains = {};
    var t = 4 * 60;
    function loop(i) {
      if (i >= maxCalls || t >= 1440) return Promise.resolve();
      return Promise.resolve(getJ(dateStr.replace(/-/g, ''), pad(Math.floor(t / 60)) + pad(t % 60))).then(function (json) {
        var js = parseJourneys(json), added = 0, maxDep = -1;
        js.forEach(function (x) {
          var abs = absFromLocal(x.dep, dateStr);
          if (abs < t - 1) return;
          if (!trains[x.dep]) { trains[x.dep] = x; added++; }
          if (abs > maxDep) maxDep = abs;
        });
        if (!added) return;
        t = maxDep + 1;
        return loop(i + 1);
      });
    }
    return loop(0).then(function () {
      return Object.keys(trains).sort().map(function (k) { return trains[k]; });
    });
  }

  function flattenDays(days) {
    var m = {};
    Object.keys(days || {}).forEach(function (d) {
      (days[d].trains || []).forEach(function (x) { m[x.dep] = x; });
    });
    return Object.keys(m).sort().map(function (k) { return m[k]; });
  }

  // Stored trains from "now" up to the last fetched departure must equal what was just fetched.
  function windowMatches(stored, fetched, nowStr) {
    var f = fetched.map(function (x) { return x.dep; }).filter(function (d) { return d >= nowStr; });
    if (!f.length) return true;
    var last = f[f.length - 1];
    var s = (stored || []).map(function (x) { return x.dep; }).filter(function (d) { return d >= nowStr && d <= last; });
    return s.length === f.length && s.every(function (d, i) { return d === f[i]; });
  }

  // Darwin (via Huxley2) departure board -> compact list.
  function parseDarwin(json, destCrs) {
    var out = [];
    ((json && json.trainServices) || []).forEach(function (s) {
      var std = hm(s.std);
      if (std == null) return;
      var etd = String(s.etd || '');
      var cancelled = !!s.isCancelled || /cancel/i.test(etd);
      var depLive = null, delayedUnknown = false;
      if (/^\d{1,2}:\d{2}$/.test(etd)) depLive = hm(etd);
      else if (/on time/i.test(etd)) depLive = std;
      else if (/delayed/i.test(etd)) delayedUnknown = true;
      var st = null, et = null;
      (s.subsequentCallingPoints || []).forEach(function (g) {
        (g.callingPoint || []).forEach(function (cp) {
          if (cp.crs === destCrs) { st = hm(cp.st); et = String(cp.et || ''); }
        });
      });
      var arrLive = null;
      if (et != null) {
        if (/^\d{1,2}:\d{2}$/.test(et)) arrLive = hm(et);
        else if (/on time/i.test(et)) arrLive = st;
      }
      out.push({
        std: std, depLive: depLive, delayedUnknown: delayedUnknown, cancelled: cancelled,
        stArr: st, arrLive: arrLive, platform: s.platform || null,
        dest: (s.destination && s.destination[0] && s.destination[0].locationName) || null,
        reason: s.cancelReason || s.delayReason || null
      });
    });
    return out;
  }

  function wrap(x, ref) { return x < ref - 30 ? x + 1440 : x; }

  function chilternNext(trains, live, now, count) {
    var map = {};
    (trains || []).forEach(function (t) {
      var dep = absFromLocal(t.dep, now.date), arr = absFromLocal(t.arr, now.date);
      if (dep < now.minutes - 45) return;
      map[dep] = { sched: dep, schedArr: arr, dep: dep, arr: arr, status: 'tt', delay: 0, live: false };
    });
    (live || []).forEach(function (l) {
      var s = l.std;
      if (s < now.minutes - 90) s += 1440;
      var e = map[s];
      if (!e) {
        var sa = l.stArr == null ? null : wrap(l.stArr, s);
        e = map[s] = { sched: s, schedArr: sa, dep: s, arr: sa, status: 'tt', delay: 0, live: false };
      }
      e.live = true;
      e.platform = l.platform; e.dest = l.dest; e.reason = l.reason;
      if (l.cancelled) { e.status = 'cancelled'; return; }
      if (l.depLive != null) {
        var d = l.depLive; if (d < s - 60) d += 1440;
        e.dep = d; e.delay = Math.round(d - s);
        e.status = e.delay >= 1 ? 'late' : 'ontime';
      } else if (l.delayedUnknown) { e.status = 'late'; e.delay = null; }
      else { e.status = 'ontime'; }
      if (l.arrLive != null) e.arr = wrap(l.arrLive, e.dep);
      else if (e.schedArr != null) e.arr = e.schedArr + (e.dep - e.sched);
    });
    var list = Object.keys(map).map(function (k) { return map[k]; })
      .filter(function (e) { return e.status === 'cancelled' ? e.sched >= now.minutes - 1 : e.dep >= now.minutes - 0.5; })
      .sort(function (a, b) { return a.sched - b.sched; });
    var out = [], good = 0;
    for (var i = 0; i < list.length && good < count; i++) {
      out.push(list[i]);
      if (list[i].status !== 'cancelled') good++;
    }
    return out;
  }

  return {
    ID: ID, NAME: NAME, MID: MID, INNER: INNER,
    pad: pad, hm: hm, fmt: fmt, hash: hash, dateAdd: dateAdd, dayDiff: dayDiff, absFromLocal: absFromLocal,
    londonNow: londonNow, classify: classify, describeSkips: describeSkips, parseDays: parseDays,
    parseTimetable: parseTimetable, tubeCandidates: tubeCandidates, matchLive: matchLive, nextTubes: nextTubes,
    parseArrivals: parseArrivals, bakerStreetToChorleywood: bakerStreetToChorleywood, parseJourneys: parseJourneys, buildDay: buildDay, flattenDays: flattenDays,
    windowMatches: windowMatches, parseDarwin: parseDarwin, chilternNext: chilternNext
  };
});
