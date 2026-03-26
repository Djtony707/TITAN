import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { login as apiLogin } from '@/api/client';

interface AuthContextType {
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  isLoading: true,
  login: async () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check if we can reach the API — determines if auth is required
    const token = localStorage.getItem('titan-token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    fetch('/api/health', { headers })
      .then((res) => {
        if (res.ok) {
          // Either no auth required, or we have a valid token
          setIsAuthenticated(true);
        } else if (res.status === 401) {
          // Auth is required and we don't have a valid token
          localStorage.removeItem('titan-token');
          setIsAuthenticated(false);
        } else {
          // Server error or unreachable — assume authenticated to avoid blocking
          setIsAuthenticated(true);
        }
      })
      .catch(() => {
        // Network error — can't reach server, let the app load (it'll show disconnected)
        setIsAuthenticated(true);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (password: string) => {
    const { token } = await apiLogin(password);
    localStorage.setItem('titan-token', token);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('titan-token');
    setIsAuthenticated(false);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
