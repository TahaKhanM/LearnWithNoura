import { useCallback, useEffect, useState, createContext, useContext } from 'react';

/**
 * A deliberately small history-API router: four screens do not justify a
 * routing dependency. Path patterns support one `:param` segment.
 */

interface RouterValue {
  path: string;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouterValue>({ path: '/', navigate: () => {} });

export function useRouter(): RouterValue {
  return useContext(RouterContext);
}

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    if (to === window.location.pathname) return;
    window.history.pushState(null, '', to);
    setPath(to);
  }, []);

  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

/** Matches "/lesson/:id" against a live path; returns params or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
