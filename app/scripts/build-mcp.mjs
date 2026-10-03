import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(dirname, "..");
const requireFromApp = createRequire(`${appRoot}${path.sep}`);
const isBareImport = (value) => !value.startsWith(".") && !value.startsWith("/") && !value.startsWith("node:") && !/^[A-Za-z]:/.test(value);

await esbuild.build({
  entryPoints: [path.resolve(appRoot, "..", "tools", "mcp-server.mjs")],
  outfile: path.resolve(appRoot, "..", "tools", "mcp.bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: { js: "import { createRequire as __xcldCreateRequire } from 'node:module'; const require = __xcldCreateRequire(import.meta.url);" },
  plugins: [{
    name: "resolve-from-app",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => (isBareImport(args.path) ? {
        path: requireFromApp.resolve(args.path),
      } : undefined));
    },
  }],
});
