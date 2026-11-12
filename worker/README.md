# Live-data proxy (Cloudflare Worker)

Keeps the Rail Data Marketplace key out of the app. The app calls `<worker-url>/board/CLW/MYB` (or `/board/MYB/CLW`); the Worker adds the key and forwards the request.

1. Create a free Cloudflare account, then Workers & Pages > Create > Worker. Deploy the starter, then Edit code and paste `worker.js`.
2. Settings > Variables and Secrets > add a **Secret** named `RDM_KEY` with your consumer key. Deploy.
3. Open `<worker-url>/board/CLW/MYB` in a browser; you should see JSON.
4. In the app: Data & Sync Status > Live service address > paste the worker URL (no trailing path).
