import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import type { ToolIdentity } from "./compare.ts";

export const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

export function identifyTool(command: string | undefined, knownVersion?: string): ToolIdentity | null {
  if (command === undefined || command === "") return null;
  const candidates = command.includes("/") ? [resolve(command)] : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, command));
  let path: string | undefined;
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) { path = realpathSync(candidate); break; }
    } catch { /* Try the next PATH entry. */ }
  }
  if (path === undefined) return { path: command, version: knownVersion ?? null, sha256: null };
  // Keep the invocation path for --version since a multi-call executable may use argv[0].
  const result = knownVersion === undefined ? spawnSync(command, ["--version"], { encoding: "utf8", timeout: 5_000 }) : null;
  const versionText = result?.status === 0 ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split(/\r?\n/)[0] : undefined;
  // A TypeScript 7 npm wrapper has an executable path resolver beside it. Hash
  // both the wrapper and the platform compiler rather than claiming the wrapper
  // hash actually identifies the separately distributed native binary.
  let native: { path: string; sha256: string } | undefined;
  const resolver = join(path, "..", "..", "lib", "getExePath.js");
  try {
    if (statSync(resolver).isFile() && readFileSync(path, "utf8").includes('../lib/tsc.js')) {
      const compilerPackage = JSON.parse(readFileSync(join(resolver, "..", "..", "package.json"), "utf8"));
      const platformPackage = `@typescript/typescript-${process.platform}-${process.arch}`;
      if (compilerPackage.name === "typescript" && Object.hasOwn(compilerPackage.optionalDependencies ?? {}, platformPackage)) {
        const platformBin = Bun.resolveSync(`${platformPackage}/package.json`, join(resolver, ".."));
        const executable = join(platformBin, "..", "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
        native = { path: realpathSync(executable), sha256: sha256(readFileSync(executable)) };
      }
    }
  } catch { /* Other wrappers retain their own path and hash only. */ }
  if (!native && versionText?.includes("(tsrs ")) {
    try {
      const wrapper = readFileSync(path).subarray(0, 500).toString("utf8");
      const resolver = join(path, "..", "..", "lib", "getExePath.js");
      if (wrapper.startsWith("#!") && wrapper.includes('../lib/tsrs.js') && statSync(resolver).isFile()) {
        // Run the npm distribution's own platform selector using the same Node
        // command as its launcher; this honors Linux libc and TSRS_BINARY.
        const located = spawnSync("node", ["--input-type=module", "-e",
          "const {pathToFileURL}=await import('node:url'); const mod=await import(pathToFileURL(process.argv[1])); console.log(mod.default())", resolver],
          { encoding: "utf8", timeout: 5_000 });
        if (located.status === 0 && located.stdout?.trim()) {
          const executable = realpathSync(located.stdout.trim());
          native = { path: executable, sha256: sha256(readFileSync(executable)) };
        }
      }
    } catch { /* Keep wrapper-only evidence. */ }
  }
  return { path, version: knownVersion ?? (versionText || null), sha256: sha256(readFileSync(path)), ...(native && { native }) };
}
