import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { Banner, Card } from '../components/ui';
import { ApiFailure, api } from '../lib/api';
import { useAuth } from '../lib/auth-context';
import { COPY, useUi } from '../lib/ui-context';

/**
 * Where the magic link lands. The token in the URL is exchanged for a session
 * once and is then dead, so a link forwarded on or left in browser history
 * cannot be replayed.
 *
 * The token is also stripped from the address bar as soon as it is spent —
 * a URL that still carries a credential gets copied into chat messages.
 */
export function MagicLinkPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const { signIn } = useAuth();
  const { t } = useUi();

  const [error, setError] = useState<string | null>(null);
  // StrictMode mounts effects twice in development; a one-shot token would be
  // consumed by the first run and rejected by the second, which looks like a
  // broken link.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (!token) {
      setError(t({ en: 'That link is missing its token.', bn: 'এই লিংকে টোকেন নেই।' }));
      return;
    }

    api
      .consumeMagicLink(token)
      .then((result) => {
        signIn(result.token, result.user);
        window.history.replaceState({}, '', '/auth/magic');
        navigate(result.user.role === 'authority' || result.user.role === 'admin' ? '/queue' : '/', { replace: true });
      })
      .catch((err) => setError(err instanceof ApiFailure ? err.message : String(err)));
  }, [token, signIn, navigate, t]);

  return (
    <div style={{ maxWidth: 440, margin: '0 auto' }}>
      <div className="page-head center">
        <h1>{error ? t({ en: 'That link did not work', bn: 'লিংকটি কাজ করেনি' }) : t({ en: 'Signing you in…', bn: 'সাইন ইন করা হচ্ছে…' })}</h1>
      </div>

      <Card>
        {error ? (
          <div className="stack">
            <Banner tone="bad" icon="alert">
              {error}
            </Banner>
            <p className="small dim">
              {t({
                en: 'Sign-in links can only be used once, and they expire. Ask for a new one and it will work.',
                bn: 'সাইন ইন লিংক একবারই ব্যবহার করা যায় এবং মেয়াদ শেষ হয়ে যায়। নতুন একটি চাইলেই কাজ করবে।',
              })}
            </p>
            <Link className="btn primary wide" to="/signin">
              {t({ en: 'Get a new link', bn: 'নতুন লিংক নিন' })}
            </Link>
          </div>
        ) : (
          <div className="row" style={{ gap: 10, justifyContent: 'center', padding: '8px 0' }}>
            <Icon name="refresh" size={18} />
            <span className="dim">{t(COPY.loading)}</span>
          </div>
        )}
      </Card>
    </div>
  );
}
