import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { EmptyState } from './components/ui';
import { useAuth } from './lib/auth-context';
import { useUi } from './lib/ui-context';

import { MapPage } from './pages/MapPage';
import { IssuePage } from './pages/IssuePage';
import { ReportPage } from './pages/ReportPage';
import { MyReportsPage } from './pages/MyReportsPage';
import { DashboardPage } from './pages/DashboardPage';
import { QueuePage } from './pages/QueuePage';
import { ReviewPage } from './pages/ReviewPage';
import { SignInPage } from './pages/SignInPage';
import { HistoryPage, ReportHistoryPage } from './pages/HistoryPage';
import { MagicLinkPage } from './pages/MagicLinkPage';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<MapPage />} />
        <Route path="/issue/:id" element={<IssuePage />} />
        <Route path="/report" element={<ReportPage />} />
        <Route path="/mine" element={<RequireUser><MyReportsPage /></RequireUser>} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/history" element={<RequireUser><HistoryPage /></RequireUser>} />
        <Route path="/history/:id" element={<RequireUser><ReportHistoryPage /></RequireUser>} />
        <Route path="/queue" element={<RequireStaff><QueuePage /></RequireStaff>} />
        <Route path="/review" element={<RequireStaff><ReviewPage /></RequireStaff>} />
        <Route path="/signin" element={<SignInPage />} />
        <Route path="/auth/magic" element={<MagicLinkPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  );
}

function RequireUser({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/signin" replace />;
  return <>{children}</>;
}

function RequireStaff({ children }: { children: React.ReactNode }) {
  const { user, loading, isStaff } = useAuth();
  const { t } = useUi();
  if (loading) return null;
  if (!user) return <Navigate to="/signin" replace />;
  if (!isStaff) {
    return (
      <EmptyState icon="shield" title={t({ en: 'Authority access only', bn: 'শুধু কর্তৃপক্ষের জন্য' })}>
        {t({
          en: 'This section belongs to the city departments. Everything the public can see is on the map and the dashboard.',
          bn: 'এই অংশটি সিটি কর্পোরেশনের বিভাগগুলোর জন্য। জনগণের জন্য সব তথ্য মানচিত্র ও ড্যাশবোর্ডে আছে।',
        })}
      </EmptyState>
    );
  }
  return <>{children}</>;
}

function NotFound() {
  const { t } = useUi();
  return (
    <EmptyState icon="search" title={t({ en: 'Nothing at this address', bn: 'এই ঠিকানায় কিছু নেই' })}>
      {t({ en: 'Check the link, or go back to the map.', bn: 'লিংকটি দেখে নিন, অথবা মানচিত্রে ফিরে যান।' })}
    </EmptyState>
  );
}
