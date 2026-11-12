import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    port: 5173,
    // scripts/dev.sh sets BIOCOMPUTE_API to the port it started the API on
    proxy: { "/api": { target: process.env.BIOCOMPUTE_API ?? "http://127.0.0.1:8044", changeOrigin: false } },
  },
  // igv.js (genome browser) is one ~1.5 MB chunk, loaded only when the Genome browser tab opens
  build: { chunkSizeWarningLimit: 1700 },
});
