import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from 'sonner';

import { RequireAdmin } from '@/components/RequireAdmin';
import { ThemeToggle } from '@/components/ThemeToggle';
import { AdminFacesPage } from '@/pages/AdminFacesPage';
import { AdminLoginPage } from '@/pages/AdminLoginPage';
import { AuthPage } from '@/pages/AuthPage';
import { WelcomePage } from '@/pages/WelcomePage';

export default function App() {
  return (
    <BrowserRouter>
      <ThemeToggle />
      <Routes>
        <Route path="/" element={<AuthPage />} />
        <Route path="/bienvenida" element={<WelcomePage />} />
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
