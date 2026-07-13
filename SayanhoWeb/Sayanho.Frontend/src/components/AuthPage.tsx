import { FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import './AuthPage.css';

const AuthPage = () => {
    const { login, register } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [isRegistering, setIsRegistering] = useState(location.state?.mode === 'register');
    const [displayName, setDisplayName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        setError(null);
        setIsSubmitting(true);
        try {
            if (isRegistering) {
                await register(displayName, email, password);
            } else {
                await login(email, password);
            }
            navigate('/design', { replace: true });
        } catch (submissionError) {
            setError(submissionError instanceof Error ? submissionError.message : 'Unable to sign in.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const toggleMode = () => {
        setIsRegistering(previous => !previous);
        setError(null);
    };

    return (
        <main className="auth-page">
            <section className="auth-card" aria-labelledby="auth-title">
                <Link className="auth-brand" to="/">⚡ Sayanho</Link>
                <h1 id="auth-title">{isRegistering ? 'Create your workspace' : 'Welcome back'}</h1>
                <p>{isRegistering ? 'Keep your electrical projects private and available only to your account.' : 'Sign in to access your private projects.'}</p>

                <form onSubmit={handleSubmit}>
                    {isRegistering && (
                        <label>
                            Name
                            <input value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" maxLength={80} required />
                        </label>
                    )}
                    <label>
                        Email
                        <input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" required />
                    </label>
                    <label>
                        Password
                        <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={isRegistering ? 'new-password' : 'current-password'} minLength={12} required />
                    </label>
                    {isRegistering && <span className="auth-hint">Use at least 12 characters.</span>}
                    {error && <p className="auth-error" role="alert">{error}</p>}
                    <button type="submit" disabled={isSubmitting}>{isSubmitting ? 'Please wait…' : isRegistering ? 'Create account' : 'Sign in'}</button>
                </form>

                <button className="auth-switch" type="button" onClick={toggleMode}>
                    {isRegistering ? 'Already have an account? Sign in' : 'New to Sayanho? Create an account'}
                </button>
            </section>
        </main>
    );
};

export default AuthPage;
