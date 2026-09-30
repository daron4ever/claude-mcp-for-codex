import { readFileSync } from "node:fs";

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (lock.lockfileVersion !== 3 || !lock.packages) {
  throw new Error("Expected an npm v3 lockfile with package metadata.");
}

const packages = Object.entries(lock.packages).filter(([path]) => path !== "");
for (const [path, entry] of packages) {
  if (entry.hasInstallScript) {
    throw new Error(`Install scripts require approval before installation: ${path}`);
  }
  if (typeof entry.resolved !== "string" ||
      !entry.resolved.startsWith("https://registry.npmjs.org/")) {
    throw new Error(`Unexpected package source: ${path}`);
  }
  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
    throw new Error(`Missing SHA-512 integrity metadata: ${path}`);
  }
}
console.log(`Checked ${packages.length} packages: npm registry, SHA-512 integrity, no install scripts.`);
