import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { offlineShell } from "./build/offlineShell";

export default defineConfig({
  plugins: [react(), offlineShell()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4317",
        changeOrigin: false
      }
    }
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    sourcemap: true
  }
});
