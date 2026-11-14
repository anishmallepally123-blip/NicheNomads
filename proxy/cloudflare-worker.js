// Only needed for hosts that cannot forward requests themselves (GitHub Pages).
// Deploy as a free Cloudflare Worker, then build the site with
// VITE_IRSA_BASE=https://<your-worker>.workers.dev
// It forwards GET requests to IRSA and adds the CORS header IRSA lacks.
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" } });
    }
    const url = new URL(request.url);
    const upstream = await fetch("https://irsa.ipac.caltech.edu" + url.pathname + url.search);
    const res = new Response(upstream.body, upstream);
    res.headers.set("Access-Control-Allow-Origin", "*");
    return res;
  },
};
