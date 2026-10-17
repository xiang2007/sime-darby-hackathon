// Local dev server: serves the built page and the /api routes the same way Vercel does.
//   DATABASE_URL=postgres://localhost/apu npm run dev
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PORT = +process.env.PORT || 3000;
const ROUTES = ["health", "state", "plan", "versions", "sessions"];
execSync("sh scripts/build-vercel.sh", { stdio: "inherit" });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const m = url.pathname.match(/^\/api\/([a-z]+)\/?$/);
  if (!m) {
    if (url.pathname !== "/" && url.pathname !== "/index.html") { res.writeHead(404).end("Not found"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync("dist/index.html"));
    return;
  }
  if (!ROUTES.includes(m[1])) { res.writeHead(404).end(); return; }
  const mod = await import(`../api/${m[1]}.js`), fn = mod[req.method];
  if (!fn) { res.writeHead(405).end(); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
  const out = await fn(new Request(url, { method: req.method, headers: req.headers, body }));
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => console.log(`UCampass(PIC) on http://localhost:${PORT}`));
