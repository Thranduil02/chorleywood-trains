# Proxy (Cloudflare Worker)

Keeps API keys off the phone and shares a short cache between callers.

- `/board/{RIC|CLW|CFO|AMR}/MYB`, `/board/MYB/{RIC|CLW|CFO|AMR}`: Chiltern live board (Rail Data Marketplace). Secret `RDM_KEY`.
- `/tfl/...`: TfL arrivals, Metropolitan timetables and the journey planner (allow-listed paths only). Optional secret `TFL_KEY` (TfL app key) lifts the anonymous rate limit. Without it the app falls back to calling TfL directly.

Deploy: Workers & Pages > your worker > Edit code > paste `worker.js` > Deploy. Secrets live under Settings > Variables and Secrets.
