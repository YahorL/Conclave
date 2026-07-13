import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const HUB = process.env.CONCLAVE_HUB_URL ?? "http://localhost:7777";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      "/api": { target: HUB, changeOrigin: true },
      "/ws": { target: HUB, ws: true, changeOrigin: true },
    },
  },
});
