import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  build: { outDir: "dist" },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
    },
  },
});
