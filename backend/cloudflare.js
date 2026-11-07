// Cloudflare Tunnel + DNS for user domains. Optional: without CF_API_TOKEN/CF_ACCOUNT_ID/CF_TUNNEL_ID the panel
// shows the route an admin must add by hand instead.
// Safety: the tunnel config is read, only hostnames Kapil Cloud manages are added/removed, everything else
// (panel.gyannportal.com, ssh, existing sites) is written back unchanged. A hostname that already has a rule or a
// DNS record we did not create is refused.
const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CF_API_TOKEN || '';
const ACCOUNT = process.env.CF_ACCOUNT_ID || '';
const TUNNEL = process.env.CF_TUNNEL_ID || '';

export const cfConfigured = () => !!(TOKEN && /^[0-9a-f]{32}$/.test(ACCOUNT) && /^[0-9a-f-]{36}$/.test(TUNNEL));
export const tunnelTarget = () => `${TUNNEL}.cfargotunnel.com`;

async function cf(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.success === false) {
    throw new Error(`Cloudflare: ${data.errors?.map((e) => e.message).join('; ') || `HTTP ${r.status}`}`);
  }
  return data.result;
}

async function zoneFor(hostname) {
  const parts = hostname.split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    const name = parts.slice(i).join('.');
    const zones = await cf('GET', `/zones?name=${encodeURIComponent(name)}`);
    if (zones?.length) return zones[0];
  }
  throw new Error(`${hostname} is not in a Cloudflare zone this token can see`);
}

const getConfig = async () => (await cf('GET', `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`))?.config || { ingress: [] };
const putConfig = (config) => cf('PUT', `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`, { config });

export async function tunnelRules() {
  if (!cfConfigured()) return null;
  const cfg = await getConfig();
  return (cfg.ingress || []).map((r) => ({ hostname: r.hostname || null, service: r.service, path: r.path || null }));
}

// Adds (or updates) the rule for a hostname we manage, keeping the catch-all last.
export async function addRoute(hostname, service, { managed }) {
  const cfg = await getConfig();
  const ingress = [...(cfg.ingress || [])];
  const idx = ingress.findIndex((r) => r.hostname?.toLowerCase() === hostname);
  if (idx >= 0 && !managed) throw new Error(`The tunnel already has a route for ${hostname} that Kapil Cloud did not create. Not touching it.`);
  const rule = { hostname, service };
  if (idx >= 0) ingress[idx] = { ...ingress[idx], ...rule };
  else {
    const catchAll = ingress.findIndex((r) => !r.hostname && !r.path);
    if (catchAll >= 0) ingress.splice(catchAll, 0, rule);
    else ingress.push(rule, { service: 'http_status:404' });
  }
  await putConfig({ ...cfg, ingress });

  const zone = await zoneFor(hostname);
  const existing = await cf('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}`);
  const ours = existing.find((d) => d.type === 'CNAME' && d.content === tunnelTarget());
  if (ours) return ours.id;
  if (existing.length) throw new Error(`${hostname} already has a DNS record (${existing[0].type} ${existing[0].content}). Remove it in Cloudflare first.`);
  const rec = await cf('POST', `/zones/${zone.id}/dns_records`, {
    type: 'CNAME', name: hostname, content: tunnelTarget(), proxied: true, comment: 'Kapil Cloud',
  });
  return rec.id;
}

export async function removeRoute(hostname, dnsRecordId) {
  const cfg = await getConfig();
  const ingress = (cfg.ingress || []).filter((r) => r.hostname?.toLowerCase() !== hostname);
  if (ingress.length !== (cfg.ingress || []).length) await putConfig({ ...cfg, ingress });
  if (dnsRecordId) {
    const zone = await zoneFor(hostname);
    // Only delete the record if it is still the tunnel CNAME we created
    const rec = await cf('GET', `/zones/${zone.id}/dns_records/${encodeURIComponent(dnsRecordId)}`).catch(() => null);
    if (rec && rec.type === 'CNAME' && rec.content === tunnelTarget() && rec.name.toLowerCase() === hostname) {
      await cf('DELETE', `/zones/${zone.id}/dns_records/${encodeURIComponent(dnsRecordId)}`);
    }
  }
}
