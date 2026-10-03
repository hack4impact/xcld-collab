import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { createBoardApi } from "./server/api.mjs";

const DIRNAME = path.dirname(fileURLToPath(import.meta.url));
const BOARDS_DIR = path.resolve(DIRNAME, "..", "boards");

export default defineConfig({
  plugins: [
    react(),
    {
      name: "xcld-board-api",
      configureServer(server) {
        const api = createBoardApi({ boardsDir: BOARDS_DIR });
        server.httpServer?.once("close", () => api.close());
        server.middlewares.use((req, res, next) => {
          void api.handle(req, res).then((handled) => {
            if (!handled) {
              next();
            }
          }, next);
        });
      },
    },
  ],
  server: {
    fs: {
      allow: [DIRNAME, path.resolve(DIRNAME, "..", "tools")],
    },
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
});