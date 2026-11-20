// Customer support: how to reach the team, and what to send so they can help quickly.
import { useLive } from '../live.js';
import { PageHeader, Card, Note, Copy, href, useApi } from '../ui.jsx';

export default function Support() {
  const { me } = useLive();
  const info = useApi('/api/public/info');
  const contact = info.data?.support;
  return (
    <>
      <PageHeader title="Support" sub="We are here to help" />
      <Card title="Contact">
        {contact ? <p className="pre-line">{contact}</p> : <p className="muted">The support contact has not been set yet. Ask the person who gave you your account.</p>}
      </Card>
      <Card title="Send this with your question">
        <dl className="kv">
          <dt>Account</dt><dd className="mono">{me.username} <Copy text={me.username} /></dd>
          <dt>Account ID</dt><dd className="mono">{me.id} <Copy text={String(me.id)} /></dd>
        </dl>
        <p className="muted small">Plus the name of the app, database or server, and what you expected to happen.</p>
      </Card>
      <Card title="Before you write">
        <ul className="plain">
          <li>App does not start? Open the app → Deploy log and Logs. Most problems are a wrong start command or a missing variable in Environment.</li>
          <li>Site not reachable? Check Domains: a custom domain needs its DNS records and Verify.</li>
          <li>Services stopped? Your wallet may be empty: <a href={href('wallet')}>Plans, billing &amp; wallet</a>.</li>
        </ul>
      </Card>
      <Note>Never send passwords, private keys or tokens to support. We never ask for them.</Note>
    </>
  );
}
