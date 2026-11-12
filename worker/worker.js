// Cloudflare Worker: keeps the Rail Data Marketplace key off the phone.
// Secret needed: RDM_KEY (your Rail Data Marketplace consumer key).
const ALLOWED_ORIGIN = 'https://thranduil02.github.io';
const BASE = 'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120';
const STATIONS = ['CLW', 'MYB'];

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

    const m = new URL(request.url).pathname.match(/^\/board\/([A-Z]{3})\/([A-Z]{3})$/);
    if (!m || m[1] === m[2] || !STATIONS.includes(m[1]) || !STATIONS.includes(m[2])) {
      return new Response('Not found', { status: 404, headers: cors });
    }
    const upstream = `${BASE}/GetDepBoardWithDetails/${m[1]}?filterCRS=${m[2]}&filterType=to&numRows=8`;
    const res = await fetch(upstream, {
      headers: { 'x-apikey': env.RDM_KEY },
      // share one upstream request between callers for 25 s; never cache errors
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 25, '400-599': 0 } },
    });
    return new Response(res.body, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  },
};
