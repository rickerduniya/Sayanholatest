import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { API_URL, AUTH_TOKEN_KEY } from '../config/api';

export interface AuthUser {
    id: string;
    email: string;
    displayName: string;
}

interface AuthenticationResponse {
    token: string;
    user: AuthUser;
}

interface AuthContextValue {
    user: AuthUser | null;
    isLoading: boolean;
    login: (email: string, password: string) => Promise<void>;
    register: (displayName: string, email: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const getErrorMessage = (error: unknown) => {
    if (axios.isAxiosError(error)) {
        return error.response?.data?.message || 'Unable to complete your request.';
    }
    return 'Unable to complete your request.';
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
    const [user, setUser] = useState<AuthUser | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    const setSession = useCallback((response: AuthenticationResponse) => {
        sessionStorage.setItem(AUTH_TOKEN_KEY, response.token);
        setUser(response.user);
    }, []);

    const clearSession = useCallback(() => {
        sessionStorage.removeItem(AUTH_TOKEN_KEY);
        setUser(null);
    }, []);

    useEffect(() => {
        const restoreSession = async () => {
            const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
            if (!token) {
                setIsLoading(false);
                return;
            }

            try {
                const response = await axios.get<AuthUser>(`${API_URL}/auth/me`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                setUser(response.data);
            } catch {
                clearSession();
            } finally {
                setIsLoading(false);
            }
        };

        restoreSession();
    }, [clearSession]);

    const login = useCallback(async (email: string, password: string) => {
        try {
            const response = await axios.post<AuthenticationResponse>(`${API_URL}/auth/login`, { email, password });
            setSession(response.data);
        } catch (error) {
            throw new Error(getErrorMessage(error));
        }
    }, [setSession]);

    const register = useCallback(async (displayName: string, email: string, password: string) => {
        try {
            const response = await axios.post<AuthenticationResponse>(`${API_URL}/auth/register`, { displayName, email, password });
            setSession(response.data);
        } catch (error) {
            throw new Error(getErrorMessage(error));
        }
    }, [setSession]);

    const logout = useCallback(async () => {
        const token = sessionStorage.getItem(AUTH_TOKEN_KEY);
        try {
            if (token) {
                await axios.post(`${API_URL}/auth/logout`, null, { headers: { Authorization: `Bearer ${token}` } });
            }
        } finally {
            clearSession();
        }
    }, [clearSession]);

    const value = useMemo(() => ({ user, isLoading, login, register, logout }), [user, isLoading, login, register, logout]);
    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within AuthProvider.');
    }
    return context;
};
