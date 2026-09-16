import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

import { ThemeProvider } from './context/ThemeContext'
import { AuthProvider } from './auth/AuthContext'
import { serverWake } from './services/serverWakeService'

// Start waking the backend before React even mounts.
//
// The backend sleeps when idle and a cold start costs 20-30s. Kicking the probe
// off here means the wake overlaps with page render and with the time the user
// spends on the landing page, so by the time they sign in the server is usually
// already up. This also starts the idle keep-alive loop that pings the backend
// every 3 minutes of inactivity to stop it suspending mid-session.
//
// Disabled in local development via VITE_DISABLE_SERVER_WAKE=true — the local
// backend never suspends, so the wake service and its banner are not needed.
if (!import.meta.env.VITE_DISABLE_SERVER_WAKE) {
    void serverWake.start();
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <ThemeProvider>
            <AuthProvider>
                <App />
            </AuthProvider>
        </ThemeProvider>
    </React.StrictMode>,
)
