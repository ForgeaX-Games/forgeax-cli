import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3701,
    proxy: {
      "/api": "http://127.0.0.1:3700",
      "/ws": { target: "ws://127.0.0.1:3700", ws: true },
    },
  },
  build: {
    outDir: "dist",
  },
  base: "/admin/",
});
