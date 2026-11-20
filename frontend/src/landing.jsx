// Public landing page for Sampanna Cloud (shown at / to visitors who are not logged in).
// Prices come live from the panel's active plans (/api/public/info), so the page never shows a stale price.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from './lib.jsx';
import './index.css';
import './cloud.css';
import './landing.css';

applyTheme();

const money = (paisa, cur) => `${cur} ${(paisa / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const ram = (mb) => (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`);

const FEATURES = [
  ['Deploy from Git', 'Paste a GitHub link, add your .env and press Deploy. Node.js, Next.js, React, NestJS, Express, Python, Laravel and static sites.'],
  ['Free subdomain + HTTPS', 'Every app gets its own address like shop-you.{domain} with SSL, right after the first deploy. Add your own domain any time.'],
  ['Cloud servers (VPS)', 'Your own Linux server with root access, browser terminal and SSH. Pick a size; upgrade when you grow.'],
  ['Managed databases', 'PostgreSQL, MySQL and MongoDB in one click, private to your apps, dumped to a separate backup disk every night.'],
  ['Pay per day', 'A prepaid wallet in Nepali rupees. You are charged by the hour, only for what is running. No card, no surprise bill.'],
  ['Hosted in Nepal', 'Servers in Kathmandu, close to your users. Monitoring, snapshots and backups are included.'],
];

const STEPS = [
  ['Create an account', 'Sign up in a minute. No credit card.'],
  ['Top up your wallet', 'Pay by eSewa, Khalti or bank; the balance appears in your wallet.'],
  ['Deploy', 'Pick “Main server” and a plan, paste your repo. Your app is live on its own subdomain.'],
];

const FAQ = [
  ['Do I need my own server?', 'No. Choose “Main server” when you create an application and Sampanna Cloud runs it for you. Take a VPS only if you want full control.'],
  ['How does billing work?', 'Each app, server or database has a price per day. It is taken from your wallet every hour while it exists. Delete it and the charges stop.'],
  ['What happens if my balance runs out?', 'You get a grace period. After that your services are stopped, never deleted, and start again after a top-up.'],
  ['Can I use my own domain?', 'Yes. Request it on the Domains page; it is routed through Cloudflare with free SSL.'],
  ['Are my databases backed up?', 'Yes, every night to a separate disk. You can download your dumps from the Backups page.'],
];

const KINDS = [['app', 'App hosting'], ['server', 'Servers'], ['database', 'Databases']];

function Pricing({ info }) {
  const [kind, setKind] = useState('app');
  const list = (info?.plans || []).filter((p) => p.kind === kind);
  return (
    <section id="pricing" className="lp-section">
      <h2>Simple daily prices</h2>
      <p className="lp-lead">Charged by the hour from your wallet. Delete anytime.</p>
      <div className="lp-tabs" role="tablist">
        {KINDS.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={kind === id} onClick={() => setKind(id)}>{label}</button>)}
      </div>
      {!info ? <p className="lp-lead">Loading prices…</p> : !list.length ? <p className="lp-lead">Prices coming soon.</p> : (
        <div className="lp-plans">
          {list.map((p, i) => (
            <div key={p.name} className={`lp-plan ${i === Math.min(1, list.length - 1) ? 'is-pop' : ''}`}>
              <h3>{p.name}</h3>
              <div className="lp-price">{money(p.priceDay, info.currency)}<small>/day</small></div>
              <div className="lp-month">≈ {money(p.priceDay * 30, info.currency)} per month</div>
              <ul>
                {p.cpu && <li>{p.cpu} vCPU</li>}
                <li>{ram(p.memoryMb)} RAM</li>
                {p.diskGb && <li>{p.diskGb} GB SSD</li>}
                {kind === 'app' && <li>{p.maxApps == null ? 'Unlimited apps' : `${p.maxApps} app${p.maxApps === 1 ? '' : 's'}`}</li>}
                {kind === 'app' && <li>Free subdomain + SSL</li>}
                {kind === 'database' && <li>Nightly backups</li>}
                {kind === 'server' && <li>Root access, terminal, SSH</li>}
              </ul>
              {p.description && <p className="lp-desc">{p.description}</p>}
              <a className="btn btn--primary" href={info.signup.enabled ? '/register' : '/login'}>Get started</a>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Landing() {
  const [info, setInfo] = useState(null);
  useEffect(() => { fetch('/api/public/info').then((r) => r.json()).then(setInfo).catch(() => {}); }, []);
  const domain = info?.domain || 'sampannatech.online';
  const signup = info ? info.signup.enabled : true;
  return (
    <div className="lp">
      <header className="lp-nav">
        <a className="lp-logo" href="/"><span className="brand__mark">S</span> Sampanna Cloud</a>
        <nav>
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
          <a className="btn" href="/login">Log in</a>
          {signup && <a className="btn btn--primary" href="/register">Sign up</a>}
        </nav>
      </header>

      <section className="lp-hero">
        <div className="lp-hero__text">
          <span className="lp-pill">Cloud hosting made in Nepal</span>
          <h1>Deploy your app in minutes. Pay only per day.</h1>
          <p className="lp-lead">Sampanna Cloud runs your websites, APIs, servers and databases. Push from Git, get a live HTTPS address, pay from a rupee wallet. No server setup needed.</p>
          <div className="lp-cta">
            {signup && <a className="btn btn--primary btn--big" href="/register">Create free account</a>}
            <a className="btn btn--big" href="#pricing">See prices</a>
          </div>
          {info?.signup.credit > 0 && <p className="lp-note">New accounts get {money(info.signup.credit, info.currency)} free credit.</p>}
        </div>
        <div className="lp-term" aria-hidden="true">
          <div className="lp-term__bar"><i /><i /><i /><span>deploy · shop</span></div>
          <pre>{`==> Cloning github.com/you/shop (main)
==> Install: npm ci
added 214 packages in 9s
==> Build: npm run build
✓ Compiled successfully
==> Starting with PM2
[PM2] shop online
==> Deployed.

  Live at https://shop-you.${domain}`}</pre>
        </div>
      </section>

      <section id="features" className="lp-section">
        <h2>Everything to run your project</h2>
        <div className="lp-grid">
          {FEATURES.map(([t, d]) => <div key={t} className="lp-card"><h3>{t}</h3><p>{d.replace('{domain}', domain)}</p></div>)}
        </div>
      </section>

      <section className="lp-section">
        <h2>Live in three steps</h2>
        <ol className="lp-steps">{STEPS.map(([t, d], i) => <li key={t}><span>{i + 1}</span><h3>{t}</h3><p>{d}</p></li>)}</ol>
      </section>

      <Pricing info={info} />

      <section id="faq" className="lp-section">
        <h2>Questions</h2>
        <div className="lp-faq">{FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
      </section>

      <section className="lp-final">
        <h2>Ready to go live?</h2>
        <p className="lp-lead">Create an account, top up, deploy. Your first app can be online today.</p>
        <a className="btn btn--primary btn--big" href={signup ? '/register' : '/login'}>{signup ? 'Create free account' : 'Log in'}</a>
      </section>

      <footer className="lp-foot">
        <span>© {new Date().getFullYear()} Sampanna Cloud · Kathmandu, Nepal</span>
        <span><a href="/login">Log in</a>{signup && <> · <a href="/register">Sign up</a></>}</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<React.StrictMode><Landing /></React.StrictMode>);
