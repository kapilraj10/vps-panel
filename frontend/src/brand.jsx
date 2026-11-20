// Sampanna Cloud logo: a cloud carrying an upward "deploy" arrow, on the brand blue.
// <Logo /> = mark only; <Logo wordmark /> = mark + name. Decorative when next to the name (aria-hidden).
export function LogoMark({ size = 32, title }) {
  return (
    <svg className="logomark" width={size} height={size} viewBox="0 0 32 32" role={title ? 'img' : undefined} aria-hidden={title ? undefined : 'true'} focusable="false">
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id="sc-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3a8bea" />
          <stop offset="1" stopColor="#1f5fb4" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#sc-g)" />
      <path d="M9.6 22.5h12.6a4.6 4.6 0 0 0 .7-9.15 6.6 6.6 0 0 0-12.55 1.5A3.9 3.9 0 0 0 9.6 22.5z" fill="#fff" />
      <path d="M16 20.2v-6.1M13.3 16.6 16 13.9l2.7 2.7" stroke="#1f5fb4" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ size = 32, wordmark = false, className = '' }) {
  if (!wordmark) return <LogoMark size={size} title="Sampanna Cloud" />;
  return (
    <span className={`logo ${className}`}>
      <LogoMark size={size} />
      <span className="logo__word">Sampanna<span className="logo__accent"> Cloud</span></span>
    </span>
  );
}

// Same mark as a data URI for <link rel="icon">
export const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232a78d6'/%3E%3Cpath d='M9.6 22.5h12.6a4.6 4.6 0 0 0 .7-9.15 6.6 6.6 0 0 0-12.55 1.5A3.9 3.9 0 0 0 9.6 22.5z' fill='%23fff'/%3E%3Cpath d='M16 20.2v-6.1M13.3 16.6 16 13.9l2.7 2.7' stroke='%231f5fb4' stroke-width='1.9' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
