import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5175 },
  preview: { port: 4175 },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
  },
});
