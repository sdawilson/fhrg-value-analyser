// Builds the server into one file, dist/server.js. The page (public/index.html) is served as it is.
import * as esbuild from "esbuild";
import fs from "node:fs";

fs.mkdirSync("dist", { recursive: true });
await esbuild.build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
});
