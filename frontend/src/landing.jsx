// Public landing page for Sampanna Cloud (shown at / to visitors who are not logged in).
// Prices come live from the panel's active plans (/api/public/info). Copy and links: landing.config.js.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from './lib.jsx';
import { Logo } from './brand.jsx';
import {
  APP_DOMAIN, BRAND, BILLING_LINE, BILLING_SHORT, TRIAL_TEXT, NO_CREDIT_TEXT, TRIAL_CREDIT_NPR, POPULAR_PLAN, BEST_FOR,
  PRICING_NOTE, STATUS_URL, DOCS_URL, LINKS, CONTACT, TRUST,
} from './landing.config.js';
import './index.css';
import './cloud.css';
import './landing.css';

applyTheme();

const money = (paisa, cur = 'NPR') => `${cur} ${(paisa / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const ram = (mb) => (mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`);
const DEV = import.meta.env.DEV;

const TECH = [
  ['Node.js', '#5fa04e'], ['Next.js', '#111111'], ['React', '#58c4dc'], ['NestJS', '#e0234e'], ['Express', '#6b6b6b'],
  ['Python', '#3776ab'], ['Laravel', '#ff2d20'], ['PostgreSQL', '#4169e1'], ['MySQL', '#00758f'], ['MongoDB', '#47a248'],
];

const FEATURES = [
  ['Deploy from Git', 'Paste a GitHub link, add your .env and press Deploy. Node.js, Next.js, React, NestJS, Express, Python, Laravel, static sites and Docker.'],
  ['Free HTTPS subdomain', `Every app gets its own address like shop-you.${APP_DOMAIN} with SSL, right after the first deploy. Add your own domain any time.`],
  ['Cloud servers (VPS)', 'Your own Linux server with root access, browser terminal and SSH. Pick a size; upgrade when you grow.'],
  ['Managed databases', 'PostgreSQL, MySQL, MongoDB and Redis in one click, private to your apps, backed up every night to a separate disk.'],
  ['Prepaid in rupees', `${BILLING_LINE} No dollar card, no surprise bill.`],
  ['Servers in Kathmandu', 'Close to your users in Nepal. Monitoring, snapshots and backups are included.'],
];

// Factual, no claims about other companies beyond how they usually work. Keep it that way.
const COMPARE = [
  ['Payment', 'NPR with eSewa, Khalti or bank transfer', 'USD with an international card'],
  ['Server location', 'Kathmandu, Nepal', 'Abroad (often Singapore, India, Europe or the US)'],
  ['Latency from Nepal', 'Traffic stays inside Nepal: a shorter route for users here', 'Traffic leaves Nepal; depends on the region you pick'],
  ['Billing', 'Prepaid wallet: price per day, billed hourly, stop anytime', 'Monthly or usage bill charged to your card'],
  ['Support', 'Local team in Nepali or English, also on WhatsApp', 'Mostly English, through tickets, email or forums (varies by plan)'],
];

const STEPS = [
  ['Create an account', 'Sign up in a minute. No credit card.'],
  ['Top up your wallet', 'Pay with eSewa, Khalti or bank transfer; the balance appears in your wallet.'],
  ['Deploy', 'Paste your GitHub repo, pick a plan, press Deploy. Your app goes live on its own HTTPS subdomain.'],
];

const FAQ = [
  ['Do I need a credit card?', 'No. You top up a prepaid wallet in Nepali rupees. No dollar or international card needed.'],
  ['Which payment methods are accepted?', 'eSewa, Khalti and bank transfer.'], // TODO(Kapil): confirm the list (Fonepay? cash?)
  ['Where are the servers located?', 'In Kathmandu, Nepal.'],
  ['How does billing work?', BILLING_LINE],
  ['Do I need my own server?', 'No. Deploy straight to Sampanna Cloud. Rent a VPS or connect your own only if you want full control.'],
  ['What happens if my balance runs out?', 'You get a grace period. After that your services are stopped, never deleted, and they start again after a top-up.'],
  // TODO(Kapil): confirm the refund policy before going live; link LINKS.refund when the page exists
  ['Can I get a refund of my wallet balance?', 'Unused balance can be refunded on request. Contact support.'],
  // TODO(Kapil): confirm support hours / channels
  ['Do you offer support in Nepali?', 'Yes, in Nepali and English, by email, phone and WhatsApp.'],
  ['Can I use my own domain?', 'Yes. Add it on the Domains page, verify it with a DNS record, and it gets free SSL.'],
  ['Are my databases backed up?', 'Yes, every night to a separate disk. You can download your dumps from the Backups page.'],
];

const KINDS = [['app', 'App hosting'], ['server', 'Servers'], ['database', 'Databases']];

function Pricing({ info, signup }) {
  const kinds = KINDS.filter(([id]) => (info?.plans || []).some((p) => p.kind === id));
  const [kind, setKind] = useState('app');
  const active = kinds.some(([id]) => id === kind) ? kind : kinds[0]?.[0];
  const list = (info?.plans || []).filter((p) => p.kind === active);
  return (
    <section id="pricing" className="lp-section" aria-labelledby="pricing-title">
      <h2 id="pricing-title">Simple prices in rupees</h2>
      <p className="lp-lead">{BILLING_LINE}</p>
      {kinds.length > 1 && (
        <div className="lp-tabs" role="tablist" aria-label="Product">
          {kinds.map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={active === id} onClick={() => setKind(id)}>{label}</button>)}
        </div>
      )}
      {!info ? <p className="lp-lead" aria-live="polite">Loading prices…</p> : !list.length ? <p className="lp-lead">Prices coming soon.</p> : (
        <div className="lp-plans">
          {list.map((p) => {
            const popular = p.name.toLowerCase() === POPULAR_PLAN.toLowerCase();
            const bestFor = BEST_FOR[p.name.toLowerCase()] || p.description;
            return (
              <article key={p.name} className={`lp-plan ${popular ? 'is-pop' : ''}`} aria-label={`${p.name} plan`}>
                {popular && <span className="lp-badge">Most popular</span>}
                <h3>{p.name}</h3>
                <div className="lp-price">{money(p.priceDay, info.currency)}<small> /day</small></div>
                <div className="lp-month">≈ <strong>{money(p.priceDay * 30, info.currency)}</strong> per month (30 days)</div>
                {bestFor && <p className="lp-best">{bestFor}</p>}
                <ul>
                  {p.cpu && <li>{p.cpu} vCPU</li>}
                  <li>{ram(p.memoryMb)} RAM</li>
                  {p.diskGb && <li>{p.diskGb} GB SSD</li>}
                  {active === 'app' && <li>{p.maxApps == null ? 'Unlimited apps' : `${p.maxApps} app${p.maxApps === 1 ? '' : 's'}`}</li>}
                  {active === 'app' && <li>Free HTTPS subdomain</li>}
                  {active === 'database' && <li>Nightly backups</li>}
                  {active === 'server' && <li>Root access, terminal, SSH</li>}
                </ul>
                <a className={`btn ${popular ? 'btn--primary' : ''}`} href={signup ? '/register' : '/login'}>Get started<span className="sr-only"> with {p.name}</span></a>
              </article>
            );
          })}
        </div>
      )}
      <p className="lp-note">{PRICING_NOTE}</p>
    </section>
  );
}

// Shows only real numbers. In `npm run dev` empty slots appear as dashed PLACEHOLDER boxes to remind you.
function Trust() {
  const stats = [
    TRUST.appsDeployed != null && ['Apps deployed', TRUST.appsDeployed.toLocaleString('en-IN')],
    TRUST.uptimePercent != null && ['Uptime', `${TRUST.uptimePercent}%`],
  ].filter(Boolean);
  const quotes = TRUST.testimonials || [];
  const hasStatus = STATUS_URL && STATUS_URL !== '#';
  if (!stats.length && !quotes.length && !hasStatus && !DEV) return null;
  return (
    <section className="lp-section" aria-labelledby="trust-title">
      <h2 id="trust-title">Trusted by builders in Nepal</h2>
      <div className="lp-stats">
        {stats.map(([label, value]) => <div key={label} className="lp-stat"><strong>{value}</strong><span>{label}</span></div>)}
        {DEV && TRUST.appsDeployed == null && <div className="lp-stat lp-ph"><strong>—</strong><span>PLACEHOLDER: apps deployed</span></div>}
        {DEV && TRUST.uptimePercent == null && <div className="lp-stat lp-ph"><strong>—%</strong><span>PLACEHOLDER: uptime</span></div>}
      </div>
      {(quotes.length > 0 || DEV) && (
        <div className="lp-grid">
          {quotes.map((t) => (
            <figure key={t.name} className="lp-card lp-quote">
              <blockquote>“{t.quote}”</blockquote>
              <figcaption><strong>{t.name}</strong><span>{t.role}{t.project ? ` · ${t.project}` : ''}</span></figcaption>
            </figure>
          ))}
          {DEV && !quotes.length && [1, 2, 3].map((n) => <figure key={n} className="lp-card lp-quote lp-ph"><blockquote>PLACEHOLDER testimonial {n}: real customer words, with permission.</blockquote><figcaption><strong>Name</strong><span>Role · Project</span></figcaption></figure>)}
        </div>
      )}
      {hasStatus && <p className="lp-note"><a href={STATUS_URL}>See live system status →</a></p>}
    </section>
  );
}

function Landing() {
  const [info, setInfo] = useState(null);
  useEffect(() => { fetch('/api/public/info').then((r) => r.json()).then(setInfo).catch(() => {}); }, []);
  const signup = info ? info.signup.enabled : true;
  const creditNpr = TRIAL_CREDIT_NPR ?? (info?.signup.credit ? info.signup.credit / 100 : 0);
  const trial = creditNpr > 0 ? TRIAL_TEXT.replace('{amount}', creditNpr.toLocaleString('en-IN')) : NO_CREDIT_TEXT;
  const support = info?.support;
  return (
    <div className="lp">
      <a className="skip" href="#main">Skip to content</a>
      <header className="lp-nav">
        <a className="lp-logo" href="/" aria-label={`${BRAND} home`}><Logo wordmark size={30} /></a>
        <nav aria-label="Main">
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#faq">FAQ</a>
          <a className="btn" href="/login">Log in</a>
          {signup && <a className="btn btn--primary" href="/register">Sign up</a>}
        </nav>
      </header>

      <main id="main">
        <section className="lp-hero" aria-labelledby="hero-title">
          <div className="lp-hero__text">
            <span className="lp-pill">Cloud hosting made in Nepal</span>
            <h1 id="hero-title">Deploy your app in Nepal. Pay in rupees, by the hour.</h1>
            <p className="lp-lead">No dollar card needed: top up with eSewa, Khalti or bank. Your apps, servers and databases run on servers in Kathmandu, and every app gets a free HTTPS subdomain.</p>
            <div className="lp-cta">
              {signup && <a className="btn btn--primary btn--big" href="/register">Create free account</a>}
              <a className="btn btn--big" href="#pricing">See prices</a>
            </div>
            <p className="lp-trial">{trial}</p>
            <ul className="lp-tech" aria-label="Works with">
              {TECH.map(([name, color]) => <li key={name}><span className="lp-tech__dot" style={{ background: color }} aria-hidden="true" />{name}</li>)}
            </ul>
          </div>
          <div className="lp-term" role="img" aria-label={`A deploy log: the app is cloned, built and started, then live at https://shop-you.${APP_DOMAIN}`}>
            <div className="lp-term__bar" aria-hidden="true"><i /><i /><i /><span>deploy · shop</span></div>
            <pre aria-hidden="true">
              {['==> Cloning github.com/you/shop (main)', '==> Install: npm ci', 'added 214 packages in 9s', '==> Build: npm run build', '✓ Compiled successfully', '==> Starting with PM2', '[PM2] shop online', '==> Deployed.']
                .map((l, i) => <span key={l} className="lp-line" style={{ animationDelay: `${0.25 + i * 0.35}s` }}>{l}{'\n'}</span>)}
              <span className="lp-line lp-live" style={{ animationDelay: '3.2s' }}>{'\n'}  Live at https://shop-you.{APP_DOMAIN}</span>
            </pre>
          </div>
        </section>

        <section id="features" className="lp-section" aria-labelledby="features-title">
          <h2 id="features-title">Everything to run your project</h2>
          <div className="lp-grid">
            {FEATURES.map(([t, d]) => <div key={t} className="lp-card"><h3>{t}</h3><p>{d}</p></div>)}
          </div>
        </section>

        <section className="lp-section" aria-labelledby="why-title">
          <h2 id="why-title">Why Sampanna Cloud</h2>
          <p className="lp-lead">How hosting here compares with typical foreign platforms such as Vercel, Render or DigitalOcean.</p>
          <div className="lp-compare-wrap">
            <table className="lp-compare">
              <thead><tr><th scope="col"><span className="sr-only">Topic</span></th><th scope="col">{BRAND}</th><th scope="col">Typical foreign hosting</th></tr></thead>
              <tbody>
                {COMPARE.map(([topic, us, them]) => (
                  <tr key={topic}><th scope="row">{topic}</th><td data-label={BRAND}>{us}</td><td data-label="Typical foreign hosting">{them}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lp-section" aria-labelledby="steps-title">
          <h2 id="steps-title">Live in three steps</h2>
          <ol className="lp-steps">{STEPS.map(([t, d], i) => <li key={t}><span aria-hidden="true">{i + 1}</span><h3>{t}</h3><p>{d}</p></li>)}</ol>
        </section>

        <Pricing info={info} signup={signup} />
        <Trust />

        <section id="faq" className="lp-section" aria-labelledby="faq-title">
          <h2 id="faq-title">Questions</h2>
          <div className="lp-faq">{FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div>
        </section>

        <section className="lp-final" aria-labelledby="final-title">
          <h2 id="final-title">Ready to go live?</h2>
          <p className="lp-lead">Create an account, top up with eSewa or Khalti, deploy. Your first app can be online today.</p>
          <a className="btn btn--primary btn--big" href={signup ? '/register' : '/login'}>{signup ? 'Create free account' : 'Log in'}</a>
          <p className="lp-trial">{BILLING_SHORT}</p>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-foot__brand">
          <Logo wordmark size={26} />
          <p>Cloud hosting made in Nepal.</p>
        </div>
        <nav className="lp-foot__cols" aria-label="Footer">
          <div><h3>Product</h3><ul>
            <li><a href="#features">Features</a></li><li><a href="#pricing">Pricing</a></li>
            <li><a href={STATUS_URL}>Status</a></li>{/* TODO: status page */}
            <li><a href={DOCS_URL}>Docs</a></li>{/* TODO: docs */}
          </ul></div>
          <div><h3>Company</h3><ul>
            <li><a href={LINKS.about}>About</a></li>{/* TODO: about page */}
            <li><a href={`mailto:${CONTACT.email}`}>Contact</a></li>
          </ul></div>
          <div><h3>Legal</h3><ul>
            <li><a href={LINKS.terms}>Terms</a></li>{/* TODO: terms */}
            <li><a href={LINKS.privacy}>Privacy</a></li>{/* TODO: privacy */}
            <li><a href={LINKS.refund}>Refund policy</a></li>{/* TODO: refund policy */}
          </ul></div>
          <div><h3>Contact</h3><ul>
            <li><a href={`mailto:${CONTACT.email}`}>{CONTACT.email}</a></li>
            <li><a href={`tel:${CONTACT.phone.replace(/\s/g, '')}`}>{CONTACT.phone}</a></li>
            <li><a href={CONTACT.whatsapp} rel="noopener noreferrer">WhatsApp</a></li>
            <li>{CONTACT.address}</li>
          </ul></div>
        </nav>
        <div className="lp-foot__base">
          <span>© {new Date().getFullYear()} {BRAND}{support ? ` · ${support}` : ''}</span>
          <span><a href="/login">Log in</a>{signup && <> · <a href="/register">Sign up</a></>}</span>
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<React.StrictMode><Landing /></React.StrictMode>);
