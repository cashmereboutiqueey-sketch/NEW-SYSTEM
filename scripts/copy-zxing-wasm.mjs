/**
 * Put the barcode reader's WebAssembly where the site can serve it.
 *
 * The reader is only used where the browser has none of its own, which today
 * means every iPhone: Apple requires all iOS browsers to use WebKit, and
 * WebKit has no barcode reader, so Chrome on an iPhone is Safari underneath
 * and no better off.
 *
 * Copied from node_modules at build time rather than committed, so the binary
 * can never fall out of step with the package that loads it — a reader and a
 * module compiled from different versions fail at the moment somebody points a
 * camera at a price tag, which is the worst place to find out.
 *
 * Served from this site rather than a CDN on purpose. A shop with a poor line
 * should not have a till that stops scanning because somebody else's server is
 * slow.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/*
 * Found from the package root rather than from an entry point.
 *
 * The package does not export its own package.json, and the entry resolves
 * into dist/cjs or dist/es depending on how this script was loaded, while the
 * binary sits in dist/reader either way. So walk up from whatever resolved to
 * the package's own directory and take the one known path from there.
 */
let root = path.dirname(require.resolve("zxing-wasm/reader"));
while (path.basename(root) !== "zxing-wasm" && root !== path.dirname(root)) {
  root = path.dirname(root);
}
const source = path.join(root, "dist", "reader", "zxing_reader.wasm");
const targetDir = path.join(process.cwd(), "public", "zxing");
const target = path.join(targetDir, "zxing_reader.wasm");

mkdirSync(targetDir, { recursive: true });
copyFileSync(source, target);

console.log(`  zxing reader → ${path.relative(process.cwd(), target)}`);
