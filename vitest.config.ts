import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@fieldwork/core": p("./packages/core/src/index.ts"),
      "@fieldwork/zetaris": p("./packages/zetaris/src/index.ts"),
      "@fieldwork/llm": p("./packages/llm/src/index.ts"),
      "@fieldwork/sources": p("./packages/sources/src/index.ts"),
      "@fieldwork/hmem": p("./packages/hmem/src/index.ts"),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"] },
});
