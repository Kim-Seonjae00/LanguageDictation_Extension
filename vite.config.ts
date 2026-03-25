import { defineConfig, type UserConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig(({ mode }): UserConfig => {
  // 2) content build (Chrome content script: IIFE 단일파일)
  if (mode === "content") {
    return {
      build: {
        outDir: "dist",
        emptyOutDir: true, // popup 제거: content 단독 빌드
        rollupOptions: {
          input: {
            content: resolve(__dirname, "src/content/main.ts"),
          } as Record<string, string>,
          output: {
            format: "iife",
            inlineDynamicImports: true,
            entryFileNames: "content.js",
          },
        },
      },
    };
  }
  if (mode === "background") {
    return {
      build: {
        outDir: "dist",
        emptyOutDir: false,
        rollupOptions: {
          input: {
            background: resolve(__dirname, "src/background/main.ts"),
          } as Record<string, string>,
          output: {
            format: "iife",
            inlineDynamicImports: true,
            entryFileNames: "background.js",
          },
        },
      },
    };
  }

  if (mode === "pagehook") {
    return {
      publicDir: false,
      build: {
        outDir: "dist",
        emptyOutDir: false,
        rollupOptions: {
          input: resolve(__dirname, "src/content/pageHook.ts"),
          output: {
            format: "es",              // ✅ 주입할 때 type="module"이니까 ESM
            entryFileNames: "pageHook.js",
          },
        },
      },
    };
  }

  // 기본값: content로 빌드 (popup 제거)
  return {
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          content: resolve(__dirname, "src/content/main.ts"),
        } as Record<string, string>,
        output: {
          format: "iife",
          inlineDynamicImports: true,
          entryFileNames: "content.js",
        },
      },
    },
  };
});