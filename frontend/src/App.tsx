import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { Layout } from "./components/Layout";
import { BoilerProvider } from "./lib/boiler";
import { ComparePage } from "./pages/Compare";
import { CurvesPage } from "./pages/Curves";
import { DocIQPage } from "./pages/DocIQ";
import { HistoryPage } from "./pages/History";
import { LivePage } from "./pages/Live";
import { StartupDetailPage } from "./pages/StartupDetail";

export function App() {
  return (
    <BrowserRouter>
      <BoilerProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Navigate to="/live" replace />} />
            <Route path="/live" element={<LivePage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/startups/:startupId" element={<StartupDetailPage />} />
            <Route path="/startups/:startupId/compare" element={<ComparePage />} />
            <Route path="/curves" element={<CurvesPage />} />
            <Route path="/dociq" element={<DocIQPage />} />
            <Route path="*" element={<Navigate to="/live" replace />} />
          </Route>
        </Routes>
      </BoilerProvider>
    </BrowserRouter>
  );
}
