import { createContext, useContext } from 'react';

export interface AuthContextValue {
  email: string | null;
  required: boolean;
  signOut(): Promise<void>;
}

export const AuthContext = createContext<AuthContextValue>({
  email: null,
  required: false,
  signOut: async () => {},
});

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
