import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// La logique partagée avec le desktop (client API, temps réel, protocole MLS)
// vit dans packages/core et est consommée en TypeScript source.
const coreSrc = fileURLToPath(new URL("../../packages/core/src", import.meta.url));
const nodeModules = (p: string) =>
  fileURLToPath(new URL(`./node_modules/${p}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@accord\/core\/(.*)$/, replacement: `${coreSrc}/$1` },
      { find: /^react$/, replacement: nodeModules("react/index.js") },
      { find: /^react\/jsx-runtime$/, replacement: nodeModules("react/jsx-runtime.js") },
      { find: /^react-dom\/client$/, replacement: nodeModules("react-dom/client.js") },
      // Le paquet partagé vit hors de cette application : Rollup résout ses
      // imports tiers depuis le chemin réel du fichier, donc hors de ce
      // node_modules. On les ramène ici (miroir des `paths` du tsconfig).
      { find: /^@tauri-apps\/api\/(.*)$/, replacement: nodeModules("@tauri-apps/api/$1") },
      { find: /^zod$/, replacement: nodeModules("zod/index.js") },
      { find: /^tweetnacl$/, replacement: nodeModules("tweetnacl/nacl-fast.js") },
      { find: /^zustand$/, replacement: nodeModules("zustand/esm/index.mjs") },
      { find: /^zustand\/(.*)$/, replacement: nodeModules("zustand/esm/$1.mjs") },
    ],
  },
  // Port distinct du desktop pour pouvoir lancer les deux en développement.
  // `host` permet à un téléphone du réseau local d'atteindre le serveur Vite.
  server: {
    port: 1421,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
  },
  // Android embarque une WebView Chromium récente : pas besoin de transpiler
  // aussi bas que pour les navigateurs de bureau anciens.
  build: {
    target: "es2022",
    minify: "esbuild",
  },
});
