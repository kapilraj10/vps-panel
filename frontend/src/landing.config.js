// Sampanna Cloud landing page: everything you may want to change lives here.
// Plain JS (no JSX): vite.config.js also imports it to fill the SEO tags in landing.html.

// Domain shown in examples ("your app at shop.sampanna.app"). The real suffix customers get is set in the panel:
// Settings → Automatic app domain. Keep the two the same.
export const APP_DOMAIN = 'sampanna.app';

// Public address of this landing page (canonical URL, Open Graph image URL)
export const SITE_URL = 'https://cloude.sampannatech.online';

export const BRAND = 'Sampanna Cloud';

// One billing message, used everywhere on the page and the sign-up form
export const BILLING_LINE = 'Prices are shown per day and billed hourly from your prepaid wallet. Stop anytime.';
export const BILLING_SHORT = 'Shown per day · billed hourly from your wallet · stop anytime';

// Under the main button. {amount} = the welcome credit set in the panel (Settings → Welcome credit).
// TRIAL_CREDIT_NPR overrides it for the page only; null = use the panel's value. No credit → NO_CREDIT_TEXT.
export const TRIAL_TEXT = 'NPR {amount} free credit · No card needed';
export const NO_CREDIT_TEXT = 'No card needed · Pay with eSewa, Khalti or bank';
export const TRIAL_CREDIT_NPR = null;

// Pricing
export const POPULAR_PLAN = 'Professional'; // plan name that gets the "Most popular" badge (any tab)
export const BEST_FOR = { // one line under each plan, by plan name (case-insensitive); others show their description
  starter: 'Best for: a portfolio, a landing page or a small API',
  professional: 'Best for: a startup with a few apps and staging',
  business: 'Best for: agencies and busy production apps',
  'server small': 'Best for: one website or API with full control',
  'server medium': 'Best for: several apps on one server',
  'server large': 'Best for: heavy apps and builds',
  'db mini': 'Best for: development and small apps',
  'db standard': 'Best for: production databases',
};
// TODO(Kapil): confirm whether prices include 13% VAT, then keep one of these
export const VAT_TEXT = 'Prices exclude VAT';
export const PRICING_NOTE = `Hourly billing · No setup fee · Delete anytime · ${VAT_TEXT}`;

// Links (placeholder "#" until the page exists)
export const STATUS_URL = '#'; // TODO: status page URL, e.g. https://status.sampanna.app
export const DOCS_URL = '#'; // TODO: docs
export const LINKS = {
  about: '#', // TODO: About page
  terms: '#', // TODO: Terms of service
  privacy: '#', // TODO: Privacy policy
  refund: '#', // TODO: Refund policy
};
// TODO(Kapil): real contact details
export const CONTACT = {
  email: 'support@sampanna.app',
  phone: '+977 98XXXXXXXX',
  whatsapp: 'https://wa.me/97798XXXXXXXX',
  address: 'Kathmandu, Nepal',
};

// Trust section. PLACEHOLDERS: leave null / empty until you have real numbers and real customers' permission.
// Empty items are not shown on the live page (during `npm run dev` they show as dashed placeholder boxes).
export const TRUST = {
  appsDeployed: null, // e.g. 120 — real count only
  uptimePercent: null, // e.g. '99.9' — measured, from the status page
  testimonials: [
    // PLACEHOLDER example shape, do not publish invented quotes:
    // { name: 'Full name', role: 'Role, Company', project: 'What they host', quote: 'Their words, with permission.' },
  ],
};

// Search engines and link previews (also used by vite.config.js for landing.html)
export const SEO = {
  title: 'Sampanna Cloud — Cloud hosting in Nepal | Deploy apps, pay with eSewa',
  description: 'Deploy Node.js, Next.js, Python and Laravel apps, VPS and managed databases on servers in Kathmandu. Pay in rupees with eSewa, Khalti or bank. Free HTTPS subdomain, billed hourly.',
  keywords: 'cloud hosting Nepal, deploy Node.js Nepal, VPS Nepal eSewa, web hosting Nepal, Khalti hosting, Next.js hosting Nepal, managed database Nepal, Kathmandu server',
  ogImage: '/assets/og-image.png',
};
