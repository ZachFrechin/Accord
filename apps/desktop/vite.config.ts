import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The React Compiler runs as a Babel plugin. Targeting React 19 lets it
// auto-memoize components/hooks so we avoid manual useMemo/useCallback noise.
const ReactCompilerConfig = {
  target: "19",
};

// Resolve the compiler to an ABSOLUTE path relative to this config file, not
// the process cwd. In a monorepo the dependency lives in apps/desktop/node_modules,
// so a bare "babel-plugin-react-compiler" fails when tools (e.g. Vitest) run from
// the repo root. An absolute path makes resolution cwd-independent.
const reactCompilerPath = createRequire(import.meta.url).resolve(
  "babel-plugin-react-compiler",
);

// Tauri exposes the dev host through an env var when running on a device.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const host = (globalThis as any).process?.env?.TAURI_DEV_HOST as
  | string
  | undefined;

// Vite configuration for the Accord2 desktop client.
// Notes:
//  - React Compiler is enabled via @vitejs/plugin-react's babel option.
//  - The server is pinned to a fixed port because Tauri expects a stable URL.
// La logique partagée avec l'app mobile vit dans packages/core et est consommée
// en TypeScript source : un alias suffit, aucune étape de compilation.
const coreSrc = fileURLToPath(new URL("../../packages/core/src", import.meta.url));

export default defineConfig({
  // Vitest tourne depuis cette application : sans cet `include`, les tests du
  // paquet partagé (hors de son arborescence) ne seraient jamais exécutés.
  test: {
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "../../packages/core/src/**/*.{test,spec}.{ts,tsx}",
    ],
  },
  resolve: {
    alias: [
      { find: /^@accord\/core\/(.*)$/, replacement: `${coreSrc}/$1` },
      { find: /^react$/, replacement: fileURLToPath(new URL("./node_modules/react/index.js", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("./node_modules/react/jsx-runtime.js", import.meta.url)) },
      { find: /^react-dom\/client$/, replacement: fileURLToPath(new URL("./node_modules/react-dom/client.js", import.meta.url)) },
      // Le paquet partagé vit hors de cette application : Rollup résout ses
      // imports tiers depuis le chemin réel du fichier, donc hors de ce
      // node_modules. On les ramène explicitement ici (miroir des `paths` du
      // tsconfig) — même mécanique pour l'app mobile.
      { find: /^@tauri-apps\/api\/(.*)$/, replacement: fileURLToPath(new URL("./node_modules/@tauri-apps/api/$1", import.meta.url)) },
      { find: /^zod$/, replacement: fileURLToPath(new URL("./node_modules/zod/index.js", import.meta.url)) },
      { find: /^tweetnacl$/, replacement: fileURLToPath(new URL("./node_modules/tweetnacl/nacl-fast.js", import.meta.url)) },
      { find: /^zustand$/, replacement: fileURLToPath(new URL("./node_modules/zustand/esm/index.mjs", import.meta.url)) },
      { find: /^zustand\/(.*)$/, replacement: fileURLToPath(new URL("./node_modules/zustand/esm/$1.mjs", import.meta.url)) },
      { find: /^livekit-client$/, replacement: fileURLToPath(new URL("./node_modules/livekit-client/dist/livekit-client.esm.mjs", import.meta.url)) },
    ],
  },
  plugins: [
    react({
      babel: {
        plugins: [[reactCompilerPath, ReactCompilerConfig]],
      },
    }),
  ],

  // Prevent Vite from clearing rust compiler errors in the terminal.
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // src-tauri is watched by the Tauri CLI, not by Vite.
      ignored: ["**/src-tauri/**"],
    },
  },

  // Produce a predictable bundle location that Tauri points at.
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
