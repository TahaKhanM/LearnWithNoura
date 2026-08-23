import { createContext, useContext } from 'react';

export interface RouterValue { path: string; navigate: (to: string) => void }
export const RouterContext = createContext<RouterValue>({ path: '/', navigate: () => {} });
export function useRouter(): RouterValue { return useContext(RouterContext); }
