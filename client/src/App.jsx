import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { SessionProvider, useSession } from './lib/session.jsx';
import Shell from './components/Shell.jsx';
import Login from './pages/Login.jsx';
import Live from './pages/Live.jsx';
import Reports from './pages/Reports.jsx';
import System from './pages/System.jsx';

function Routed() {
  const { session } = useSession();
  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Live />} />
        <Route path="/reports" element={<Reports />} />
        {session.user.role === 'admin' && <Route path="/system" element={<System />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <BrowserRouter basename="/dashboard">
      <SessionProvider>
        <Routed />
      </SessionProvider>
    </BrowserRouter>
  );
}
