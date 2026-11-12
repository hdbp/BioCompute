import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { Layout } from "@/components/layout";
import { useTheme } from "@/hooks/theme";
import LoginPage from "@/pages/login";

const Dashboard = lazy(() => import("@/pages/dashboard"));
const Nodes = lazy(() => import("@/pages/nodes"));
const Pipelines = lazy(() => import("@/pages/pipelines"));
const PipelineDetail = lazy(() => import("@/pages/pipeline-detail"));
const Studio = lazy(() => import("@/pages/studio"));
const PipelineMapPage = lazy(() => import("@/pages/pipeline-map"));
const Experiments = lazy(() => import("@/pages/experiments"));
const ExperimentEditor = lazy(() => import("@/pages/experiment-editor"));
const Jobs = lazy(() => import("@/pages/jobs"));
const RunPage = lazy(() => import("@/pages/run"));
const Launch = lazy(() => import("@/pages/launch"));
const Results = lazy(() => import("@/pages/results"));
const Explore = lazy(() => import("@/pages/explore"));
const SettingsPage = lazy(() => import("@/pages/settings"));

export default function App() {
  useTheme();
  const token = useAuth((s) => s.token);
  if (!token) return <LoginPage />;
  return (
    <Suspense fallback={<div className="p-8 text-muted">Loading…</div>}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="nodes" element={<Nodes />} />
          <Route path="pipelines" element={<Pipelines />} />
          <Route path="pipelines/:id" element={<PipelineDetail />} />
          <Route path="pipelines/:id/map" element={<PipelineMapPage />} />
          <Route path="studio" element={<Studio />} />
          <Route path="studio/:id" element={<Studio />} />
          <Route path="experiments" element={<Experiments />} />
          <Route path="experiments/:id" element={<ExperimentEditor />} />
          <Route path="jobs" element={<Jobs />} />
          <Route path="jobs/new" element={<Launch />} />
          <Route path="runs/:id" element={<RunPage />} />
          <Route path="results" element={<Results />} />
          <Route path="results/:id" element={<Results />} />
          <Route path="explore" element={<Explore />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
