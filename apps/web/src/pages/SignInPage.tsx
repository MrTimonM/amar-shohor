import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { Banner, Card } from '../components/ui';
import { ApiFailure, api } from '../lib/api';
import { useAuth } from '../lib/auth-context';
import { COPY, useUi } from '../lib/ui-context';

/**
 * Phase 04 — sign-in. Passwordless, because the citizen this product is for
 * will not create and remember a password, and a forgotten password is a
 * citizen who stops reporting.
 *
 * One email carries two routes: a magic link and a six-digit code. That is not
 * indecision — someone reading their mail on the same device taps the link,
 * while someone signing in on a phone with their mail open on a laptop types
 * the code. Either one works, and using one cancels the other.
 */
export function SignInPage() {
  const { t } = useUi();
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'identify' | 'code'>('identify');
  const [isNewAccount, setIsNewAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const fail = (err: unknown) => {
    if (err instanceof ApiFailure) {
      setError(err.message);
      setFields(err.fields ?? {});
    } else setError(String(err));
  };

  const reset = () => {
    setError(null);
    setFields({});
  };

  const request = useMutation({
    mutationFn: async () => {
      reset();
      return api.requestEmailLogin(email, name.trim() || undefined);
    },
    onSuccess: (result) => {
      setStep('code');
      setIsNewAccount(result.isNewAccount);
    },
    onError: fail,
  });

  const verify = useMutation({
    mutationFn: () => api.verifyEmailCode(email, code, name.trim() || undefined),
    onSuccess: (result) => {
      signIn(result.token, result.user);
      navigate(result.user.role === 'authority' || result.user.role === 'admin' ? '/queue' : '/');
    },
    onError: fail,
  });

  const looksLikeEmail = /.+@.+\..+/.test(email);

  return (
    <div style={{ maxWidth: 440, margin: '0 auto' }}>
      <div className="page-head center">
        <h1>{t(COPY.signIn)}</h1>
        <p style={{ margin: '0 auto' }}>
          {t({
            en: 'You only need an account to report or verify a problem. Reading the map never does.',
            bn: 'সমস্যা জানাতে বা যাচাই করতেই কেবল অ্যাকাউন্ট দরকার। মানচিত্র দেখতে কখনও নয়।',
          })}
        </p>
      </div>

      <Card>
        {step === 'identify' ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              request.mutate();
            }}
          >
            <div className="field">
              <label htmlFor="email">{t({ en: 'Email address', bn: 'ইমেইল ঠিকানা' })}</label>
              <input
                id="email"
                className="input"
                type="email"
                inputMode="email"
                autoComplete="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={Boolean(fields.email)}
                required
                autoFocus
              />
              {fields.email ? (
                <span className="err">{fields.email}</span>
              ) : (
                <span className="hint">
                  {t({
                    en: 'We send a link and a six-digit code. Use whichever is easier.',
                    bn: 'আমরা একটি লিংক ও ছয় অঙ্কের কোড পাঠাব। যেটি সহজ, সেটিই ব্যবহার করুন।',
                  })}
                </span>
              )}
            </div>

            <div className="field">
              <label htmlFor="name">
                {t({ en: 'Your name', bn: 'আপনার নাম' })} <span className="muted">({t({ en: 'optional', bn: 'ঐচ্ছিক' })})</span>
              </label>
              <input
                id="name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                placeholder={t({ en: 'Shown on problems you report', bn: 'আপনার জানানো সমস্যায় দেখানো হবে' })}
              />
            </div>

            {error && (
              <Banner tone="bad" icon="alert">
                {error}
              </Banner>
            )}

            <button type="submit" className="btn primary wide lg" disabled={request.isPending || !looksLikeEmail}>
              {request.isPending ? t(COPY.loading) : t({ en: 'Email me a link and a code', bn: 'লিংক ও কোড পাঠান' })}
            </button>
          </form>
        ) : (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              verify.mutate();
            }}
          >
            <Banner tone="accent" icon="inbox">
              {t({
                en: `Sent to ${email}. Tap the link in that email, or type the code below — either works.`,
                bn: `${email} এ পাঠানো হয়েছে। ইমেইলের লিংকে চাপ দিন, অথবা নিচে কোডটি লিখুন — দুটোই চলবে।`,
              })}
            </Banner>

            {isNewAccount && (
              <p className="tiny muted">
                {t({
                  en: 'This will create your account — confirming the email is all it takes.',
                  bn: 'এতে আপনার অ্যাকাউন্ট তৈরি হবে — ইমেইল নিশ্চিত করলেই হয়ে যাবে।',
                })}
              </p>
            )}

            <div className="field">
              <label htmlFor="code">{t({ en: 'Six-digit code', bn: 'ছয় অঙ্কের কোড' })}</label>
              <input
                id="code"
                className="input mono"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="••••••"
                style={{ fontSize: 22, letterSpacing: '0.3em', textAlign: 'center' }}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                aria-invalid={Boolean(fields.code)}
                required
                autoFocus
              />
              {fields.code && <span className="err">{fields.code}</span>}
            </div>

            {error && (
              <Banner tone="bad" icon="alert">
                {error}
              </Banner>
            )}

            <button type="submit" className="btn primary wide lg" disabled={verify.isPending || code.length !== 6}>
              {verify.isPending ? t(COPY.loading) : t(COPY.signIn)}
            </button>

            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn ghost grow"
                onClick={() => {
                  setStep('identify');
                  setCode('');
                  reset();
                }}
              >
                <Icon name="back" size={15} />
                {t({ en: 'Change address', bn: 'ঠিকানা বদলান' })}
              </button>
              <button
                type="button"
                className="btn ghost grow"
                disabled={request.isPending}
                onClick={() => {
                  setCode('');
                  request.mutate();
                }}
              >
                <Icon name="refresh" size={15} />
                {t({ en: 'Resend', bn: 'আবার পাঠান' })}
              </button>
            </div>
          </form>
        )}
      </Card>

      <p className="tiny muted center" style={{ marginTop: 14 }}>
        {t({
          en: 'Any email address works — a citizen account is created the first time you sign in.',
          bn: 'যেকোনো ইমেইল ঠিকানা চলবে — প্রথমবার সাইন ইন করলেই নাগরিক অ্যাকাউন্ট তৈরি হয়।',
        })}
      </p>
    </div>
  );
}
