// Bundles the server-side Mermaid parser worker (tools/mermaid-parse-worker.mjs) with
// jsdom and Mermaid into tools/mermaid-parse.bundle.mjs. The runtime image ships no
// node_modules, and one file also loads far faster than Mermaid's many chunks.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(dirname, "..");
const requireFromApp = createRequire(`${appRoot}${path.sep}`);
const versionOf = async (name) => JSON.parse(await readFile(requireFromApp.resolve(`${name}/package.json`), "utf8")).version;

await esbuild.build({
  entryPoints: [path.resolve(appRoot, "..", "tools", "mermaid-parse-worker.mjs")],
  outfile: path.resolve(appRoot, "..", "tools", "mermaid-parse.bundle.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "eof",
  logLevel: "warning",
  // tools/ has no node_modules; resolve bare imports from the app's.
  nodePaths: [path.join(appRoot, "node_modules")],
  // jsdom loads the optional `canvas` package in a try/catch; leave it out.
  external: ["canvas"],
  define: {
    __XCLD_MERMAID_VERSION__: JSON.stringify(await versionOf("mermaid")),
    __XCLD_JSDOM_VERSION__: JSON.stringify(await versionOf("jsdom")),
  },
  banner: { js: "import { createRequire as __xcldCreateRequire } from 'node:module'; const require = __xcldCreateRequire(import.meta.url);" },
  plugins: [{
    name: "jsdom-no-sync-xhr",
    setup(build) {
      // jsdom resolves its synchronous-XHR helper file at load time. The parser never
      // makes requests, so the bundle drops that file instead of shipping it.
      build.onLoad({ filter: /[\\/]jsdom[\\/]lib[\\/]jsdom[\\/]living[\\/]xhr[\\/]XMLHttpRequest-impl\.js$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        const patched = source.replace('require.resolve ? require.resolve("./xhr-sync-worker.js") : null', "null");
        if (patched === source) throw new Error("jsdom XMLHttpRequest-impl.js changed; update app/scripts/build-mermaid.mjs");
        return { contents: patched, loader: "js" };
      });
    },
  }, {
    name: "mermaid-flowdb-config-once",
    setup(build) {
      // Mermaid's FlowDB.addVertex deep-copies the whole Mermaid config for every labeled node
      // (`this.config = getConfig()`), about 0.4 ms each: 85% of a 500-node parse. The config
      // can't change during one parse (a FlowDB lives for one diagram), so the bundle fetches it
      // once per FlowDB, on the first labeled node (after the diagram's init). Same result.
      let patchedFiles = 0;
      build.onLoad({ filter: /[\\/]mermaid[\\/]dist[\\/].*\.mjs$/ }, async (args) => {
        const source = await readFile(args.path, "utf8");
        if (!source.includes("var FlowDB = class")) return undefined;
        const patched = source.replace(/this\.config = getConfig\(\);(\s*txt = this\.sanitizeText\(textObj\.text\.trim\(\)\);)/, "this.config = this.xcldConfig ??= getConfig();$1");
        if (patched === source) throw new Error(`Mermaid's FlowDB.addVertex changed (${args.path}); update app/scripts/build-mermaid.mjs`);
        patchedFiles += 1;
        return { contents: patched, loader: "js" };
      });
      build.onEnd((result) => {
        if (!result.errors.length && patchedFiles === 0) throw new Error("Mermaid's FlowDB wasn't found to patch; update app/scripts/build-mermaid.mjs");
      });
    },
  }],
});
