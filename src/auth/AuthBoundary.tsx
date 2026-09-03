import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthContext, type AuthContextValue } from './authContext';
import { LoginPage } from './LoginPage';

interface AuthSession {
  required: boolean;
  authenticated: boolean;
  email?: string;
}

export function AuthBoundary({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSession(await response.json() as AuthSession);
    } catch {
      setLoadError('Noura could not check access. Check your connection and try again.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const signOut = useCallback(async () => {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('Sign out failed');
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('noura.')) window.localStorage.removeItem(key);
    }
    for (const key of Object.keys(window.sessionStorage)) {
      if (key.startsWith('noura.')) window.sessionStorage.removeItem(key);
    }
    setSession({ required: true, authenticated: false });
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    email: session?.email ?? null,
    required: session?.required ?? false,
    signOut,
  }), [session?.email, session?.required, signOut]);

  if (loadError) {
    return <LoginPage serviceError={loadError} onRetry={() => void load()} onAuthenticated={setSession} />;
  }
  if (!session) {
    return <main id="main-content" className="route-loading" aria-live="polite">Checking access…</main>;
  }
  if (session.required && !session.authenticated) {
    return <LoginPage onAuthenticated={setSession} />;
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
