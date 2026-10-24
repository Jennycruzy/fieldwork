import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// React without a plugin: esbuild compiles the JSX. In development /api goes to the local API.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  esbuild: { jsx: "automatic" },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8795" } },
});
