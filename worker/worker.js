// Cloudflare Worker: keeps API keys off the phone and shares a short cache between callers.
// Secrets: RDM_KEY (Rail Data Marketplace consumer key, required for /board)
//          TFL_KEY (TfL API app key, optional but recommended for /tfl: lifts the anonymous rate limit)
const ALLOWED_ORIGIN = 'https://thranduil02.github.io';
const RDM_BASE = 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120';
const TFL_BASE = 'https://api.tfl.gov.uk';
const STATIONS = ['RIC', 'CLW', 'CFO', 'AMR', 'MYB'];

// TfL paths the app may use, with how long (seconds) a response may be shared between callers
const TFL_ROUTES = [
  { re: /^\/StopPoint\/940GZZLU[A-Z]{3}\/Arrivals$/, ttl: 20, params: [] },
  { re: /^\/Line\/metropolitan\/Timetable\/940GZZLU[A-Z]{3}\/to\/940GZZLU[A-Z]{3}$/, ttl: 600, params: [] },
  { re: /^\/Journey\/JourneyResults\/910G[A-Z]+\/to\/910G[A-Z]+$/, ttl: 600, params: ['mode', 'date', 'time', 'timeIs'] },
  // Trackernet (per-train location, platform and set number); XML. Experimental.
  { re: /^\/TrackerNet\/PredictionDetailed\/M\/[A-Z]{3}$/i, ttl: 15, params: [] },
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (origin && origin !== ALLOWED_ORIGIN) return new Response('Forbidden', { status: 403, headers: cors });

    const url = new URL(request.url);
    const reply = (res) => new Response(res.body, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });

    // Chiltern live board
    const b = url.pathname.match(/^\/board\/([A-Z]{3})\/([A-Z]{3})$/);
    if (b) {
      if (b[1] === b[2] || !STATIONS.includes(b[1]) || !STATIONS.includes(b[2])) return new Response('Not found', { status: 404, headers: cors });
      const res = await fetch(`${RDM_BASE}/GetDepBoardWithDetails/${b[1]}?filterCRS=${b[2]}&filterType=to&numRows=8`, {
        headers: { 'x-apikey': env.RDM_KEY },
        cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 25, '400-599': 0 } },
      });
      return reply(res);
    }

    // TfL passthrough
    if (url.pathname.startsWith('/tfl/')) {
      const path = url.pathname.slice(4);
      const route = TFL_ROUTES.find((r) => r.re.test(path));
      if (!route) return new Response('Not found', { status: 404, headers: cors });
      const q = new URLSearchParams();
      route.params.forEach((k) => { if (url.searchParams.has(k)) q.set(k, url.searchParams.get(k)); });
      if (env.TFL_KEY) q.set('app_key', env.TFL_KEY);
      const qs = q.toString();
      const res = await fetch(`${TFL_BASE}${path}${qs ? '?' + qs : ''}`, {
        cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': route.ttl, '400-599': 0 } },
      });
      return reply(res);
    }

    return new Response('Not found', { status: 404, headers: cors });
  },
};
