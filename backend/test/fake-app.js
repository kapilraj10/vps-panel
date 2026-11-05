// TEST ONLY: what a replica runs under fake PM2 / fake Docker. Listens on PORT (or HOST_PORT).
// /health answers 500 when the file $FAKE_FLAGS/down-<port> exists or BROKEN=1 (a "bad release").
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.HOST_PORT || process.env.PORT);
const flags = process.env.FAKE_FLAGS || '/nonexistent';
http.createServer((req, res) => {
  const down = process.env.BROKEN === '1' || fs.existsSync(path.join(flags, `down-${port}`));
  if (req.url.startsWith('/health') && down) { res.writeHead(500); return res.end('down'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ replica: process.env.KC_REPLICA, port }));
}).listen(port, '127.0.0.1', () => console.log(`fake app on ${port}`));
