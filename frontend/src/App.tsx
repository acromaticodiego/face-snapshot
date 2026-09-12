import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';

import { RequireAdmin } from '@/components/RequireAdmin';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AdminFacesPage } from '@/pages/AdminFacesPage';
import { AdminLoginPage } from '@/pages/AdminLoginPage';
import { AuthPage } from '@/pages/AuthPage';
import { HomePage } from '@/pages/HomePage';

export default function App() {
  return (
    <BrowserRouter>
      <ThemeToggle />
      <Routes>
        <Route path="/" element={<AuthPage />} />
        <Route path="/home" element={<HomePage />} />
        {/* La pantalla se llamaba /bienvenida antes de mostrar la
            jornada. Se conserva la redirección para no romper enlaces
            ni marcadores que alguien tuviera guardados. */}
        <Route path="/bienvenida" element={<Navigate to="/home" replace />} />
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route
          path="/admin/faces"
          element={
            <RequireAdmin>
              <AdminFacesPage />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster
        position="top-center"
        richColors
        closeButton
        toastOptions={{ duration: 4000 }}
      />
    </BrowserRouter>
  );
}
