import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The site is fully static. IRSA does not allow direct browser calls (no CORS
// headers), so /irsa/* is forwarded to IRSA: here by the dev server, in
// production by one rewrite rule in netlify.toml or vercel.json.
const irsa = {
  target: "https://irsa.ipac.caltech.edu",
  changeOrigin: true,
  rewrite: (path: string) => path.replace(/^\/irsa/, ""),
  // The viewer stops reading a cutout once it has the image planes; close the
  // IRSA connection too, so IRSA does not count it as busy.
  configure: (proxy: import("http-proxy").Server) => {
    proxy.on("proxyReq", (proxyReq, _req, res) => {
      res.on("close", () => {
        if (!res.writableFinished) proxyReq.destroy();
      });
    });
  },
};

const simbad = {
  target: "https://simbad.cds.unistra.fr",
  changeOrigin: true,
  rewrite: (path: string) => path.replace(/^\/simbad/, ""),
};

// /api/claude is a Vercel function in production (api/claude.ts). Serve the
// same code from the dev server so the Claude features can be tried locally:
// put ANTHROPIC_API_KEY=... in frontend/.env.local (never commit it).
function claudeApi(): Plugin {
  const mount = (server: { middlewares: import("vite").Connect.Server }) => {
    server.middlewares.use("/api/claude", async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      let mod: typeof import("../api/claude");
      try {
        mod = await import("../api/claude");
      } catch {
        // Root packages not installed (npm run setup does both).
        res.statusCode = 503;
        res.end(JSON.stringify({ code: "no_key", error: "Claude isn't set up on this computer. Run npm run setup." }));
        return;
      }
      const { handleClaude, clientIp } = mod;
      if (req.method === "GET") {
        res.end(JSON.stringify({ ready: Boolean(process.env.ANTHROPIC_API_KEY) }));
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: unknown = null;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* handled as a bad request below */
      }
      const reply = await handleClaude(body, clientIp(req.headers, req.socket.remoteAddress));
      res.statusCode = reply.status;
      res.end(JSON.stringify(reply.body));
    });
  };
  return { name: "claude-api", configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig(({ mode }) => {
  const key = loadEnv(mode, process.cwd(), "").ANTHROPIC_API_KEY;
  if (key) process.env.ANTHROPIC_API_KEY = key;
  return {
  plugins: [react(), claudeApi()],
  server: { port: 5173, proxy: { "/irsa": irsa, "/simbad": simbad } },
  preview: { port: 4173, proxy: { "/irsa": irsa, "/simbad": simbad } },
  };
});
