import { useState } from 'react';
import './LoginPage.css';

interface LoginPageProps {
  serviceError?: string | null;
  onRetry?: () => void;
  onAuthenticated(session: { required: boolean; authenticated: boolean; email?: string }): void;
}

export function LoginPage({ serviceError = null, onRetry, onAuthenticated }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter both the email address and password.');
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = await response.json() as { authenticated?: boolean; email?: string; error?: string };
      if (!response.ok || !body.authenticated) {
        setError(body.error ?? 'The email or password is incorrect.');
        return;
      }
      onAuthenticated({ required: true, authenticated: true, email: body.email });
    } catch {
      setError('Noura could not reach the login service. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login" id="main-content">
      <section className="login__card" aria-labelledby="login-title">
        <div className="login__mark" aria-hidden="true">
          <svg viewBox="0 0 54 54">
            <path d="M1 44C1 19 13 3 27 3s26 16 26 41c0 7-6 9-26 9S1 51 1 44Z" fill="var(--blue)" />
            <circle cx="19" cy="17" r="3.1" fill="var(--board)" />
            <circle cx="35" cy="17" r="3.1" fill="var(--board)" />
            <path d="M20 28c3 3 9 3 12 0" stroke="var(--board)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          </svg>
        </div>
        <div className="login__intro">
          <p className="login__eyebrow">Demo access</p>
          <h1 id="login-title">Open Noura’s teaching board</h1>
          <p>Sign in before creating learners, starting lessons, or using the tutor API.</p>
        </div>

        {serviceError ? (
          <div className="login__service-error" role="alert">
            <p>{serviceError}</p>
            {onRetry && <button type="button" onClick={onRetry}>Try again</button>}
          </div>
        ) : (
          <form className="login__form" onSubmit={submit} data-testid="login-form" noValidate>
            <div className="login__field">
              <label htmlFor="login-email">Email address</label>
              <input id="login-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} disabled={submitting} />
            </div>
            <div className="login__field">
              <label htmlFor="login-password">Password</label>
              <div className="login__password">
                <input id="login-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" disabled={submitting} />
                <button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? 'Hide' : 'Show'}</button>
              </div>
            </div>
            {error && <p className="login__error" role="alert">{error}</p>}
            <button className="login__submit" type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in'}</button>
          </form>
        )}
        <p className="login__boundary">Private demo · use pretend learner details only</p>
      </section>
    </main>
  );
}
