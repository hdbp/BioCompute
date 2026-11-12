import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Toaster } from "sonner";
import "./index.css";
import App from "./App";
import { TooltipProvider } from "@/components/ui/misc";
import { ConfirmHost } from "@/components/ui/confirm";
import { ApiError } from "@/lib/api";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
});

document.documentElement.classList.add((() => { try { return localStorage.getItem("biocompute.theme") ?? "dark"; } catch { return "dark"; } })());

// A data router (needed for the unsaved-changes guard); the routes themselves stay in App.
// React Router 7 behaviour now (silences its warnings): no relative links, forms, fetchers or route actions use it
const router = createBrowserRouter([{ path: "*", element: <App /> }], {
  future: { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
        <ConfirmHost />
        <Toaster theme="system" position="bottom-right" toastOptions={{ className: "!bg-surface !border-line !text-text" }} />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
