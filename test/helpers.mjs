import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function fixture(t, options = {}) {
  await mkdir(".cache", { recursive: true });
  const directory = await mkdtemp(resolve(".cache/test-"));
  const binary = resolve(directory, "fake-claude");
  const configuration = typeof options === "function" ? options(directory) : options;
  const source = await readFile("test/fixtures/fake-claude.mjs", "utf8");
  await writeFile(binary, source.replace("const fixtureOptions = {};",
    "const fixtureOptions = " + JSON.stringify(configuration) + ";"));
  await chmod(binary, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { binary, directory };
}

export async function waitForMarker(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return Number(await readFile(path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await delay(20);
  }
  throw new Error("Synthetic child did not become ready.");
}

export function assertExited(assert, pid) {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
}
