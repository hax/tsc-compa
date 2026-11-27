// Read-only public evaluation of pinned third-party CLI distributions.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { baseline, verifyVersion, type Candidate } from "./full-compatibility.ts";
import { fileTree } from "./public-evaluation-inputs.ts";
import { REPO_ROOT } from "../src/baselines.ts";
import { sha256 } from "../src/provenance.ts";

export const addedCandidates = ["ts-rust", "tsc-rs", "tsz"] as const;
export type AddedCandidate = typeof addedCandidates[number];
export const isAddedCandidate = (candidate: Candidate): candidate is AddedCandidate => addedCandidates.some((id) => id === candidate);
const compilerPath = { "ts-rust": "lib/tsc", "tsc-rs": "tsc-rs", tsz: "tsz" } as const;
const repos = { "tsc-rs": "kazhiramatsu/tsc-rs", tsz: "tsz-org/tsz" } as const;
const rustToolchain = "1.99.1-x86_64-unknown-linux-gnu";
const rustcVersion = "rustc 1.99.1 (58cf8f9c3 2026-10-13)";
const npmPlatform = "@tsc-rs/linux-x64";
// Integrity of the two specific, smoke-tested npm distributions. The version
// is read from the registry, and changing it also requires reviewing these bytes.
const npmArchives = {
  launcherSha256: "22c0e3f19f98eac88085d2edf5b0ece99c76481c274f29964c14be2fe335e697",
  platformSha256: "05a13e235b6d6561a73bb57d412c854ea33bde888aacddcd8336245253a1be47",
} as const;
const npmNativeSha256 = "c2d321fe13ff304e40a7650ec123b96239ba1c568f3aa89cba04dfc6ac7c9f7d";
const npmSourceCommit = "4c032be6dbef6dafaae2358ece165d138f8e0da8";
const candidateEnv = (id: AddedCandidate): Record<string, string> => id === "tsz" ? { TSZ_USE_EMBEDDED_LIBS: "1" } : {};

type Implementation = {
  displayName: string; adapter: string; baselines: string[]; cliArgs: string[];
  acquisition: {
    npm?: { package: string; version: string };
    cargo?: { git?: { url: string; ref: string }; command: string; bin: string; env?: { CI: string } };
  };
};
const registry = JSON.parse(readFileSync(join(REPO_ROOT, "config/implementations.json"), "utf8")).implementations as Record<AddedCandidate, Implementation>;
export function addedCandidate(id: AddedCandidate) {
  const spec = registry[id];
  if (spec.adapter !== "tsc-cli" || !spec.baselines.includes(baseline) || !spec.cliArgs.every((arg) => /^[\w.-]+$/.test(arg))) {
    throw new Error(`Invalid public registry entry: ${id}`);
  }
  const version = id === "ts-rust" ? spec.acquisition.npm?.version : spec.acquisition.cargo?.git?.ref;
  if (!version || !(id === "ts-rust" ? /^\d+\.\d+\.\d+$/ : /^[a-f0-9]{40}$/).test(version)) throw new Error(`Missing public pin: ${id}`);
  return { id, name: spec.displayName, version: id === "ts-rust" ? version : version.slice(0, 7) };
}

const exec = (exe: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) => execFileSync(exe, args, {
  cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 60_000,
}).trim();
const digestFile = (file: string) => sha256(readFileSync(file));
const hash = (value: unknown) => sha256(JSON.stringify(value));
type NpmSource = { kind: "npm"; package: string; version: string; sourceCommit: string; platformPackage: string; launcherSha256: string; platformSha256: string };
type CargoSource = { kind: "cargo"; repository: string; commit: string; lockSha256: string; rustc: string; cargo: string; linker: string; buildImage: string };
export type PreparedSource = NpmSource | CargoSource;
export type PreparedEvidence = { source: PreparedSource; runtimeLibrariesSha256: string; environment: Record<string, string> };

function acquireNpm(root: string, distribution: string): NpmSource {
  const npm = registry["ts-rust"].acquisition.npm;
  if (!npm || npm.package !== "tsc-rs" || npm.version !== "0.8.0") throw new Error("Review the pinned ts-rust npm archive hashes before changing its package");
  const download = (url: string, digest: string, dest: string) => {
    const archive = join(root, `${digest}.tgz`);
    exec("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--retry", "3", "-o", archive, url]);
    if (digestFile(archive) !== digest) throw new Error("Pinned npm archive integrity mismatch");
    mkdirSync(dest, { recursive: true });
    exec("tar", ["--extract", "--gzip", "--file", archive, "--directory", dest, "--strip-components=1", "--no-same-owner"]);
  };
  const modules = join(root, "node_modules");
  const launcher = join(modules, npm.package);
  const nativePackage = join(modules, npmPlatform);
  download(`https://registry.npmjs.org/${npm.package}/-/${npm.package}-${npm.version}.tgz`, npmArchives.launcherSha256, launcher);
  download(`https://registry.npmjs.org/${npmPlatform}/-/linux-x64-${npm.version}.tgz`, npmArchives.platformSha256, nativePackage);
  const metadata = (path: string) => JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  const cli = metadata(launcher), native = metadata(nativePackage);
  if (cli.name !== npm.package || cli.version !== npm.version || cli.optionalDependencies?.[npmPlatform] !== npm.version ||
      native.name !== npmPlatform || native.version !== npm.version) throw new Error("Unexpected ts-rust npm package metadata");
  const compiler = join(nativePackage, compilerPath["ts-rust"]);
  const resolved = exec("node", ["--input-type=module", "-e",
    "const {pathToFileURL}=await import('node:url'); const m=await import(pathToFileURL(process.argv[1])); console.log(m.default())",
    join(launcher, "lib/getExePath.js")], root);
  if (realpathSync(resolved) !== realpathSync(compiler) || digestFile(compiler) !== npmNativeSha256) throw new Error("Unexpected ts-rust native executable");
  verifyVersion("ts-rust", join(launcher, "bin/tsc-rs"));
  // Preserve the platform package layout, not the JavaScript launcher. The
  // executable discovers sibling declaration files by its native location.
  cpSync(nativePackage, distribution, { recursive: true });
  return { kind: "npm", package: npm.package, version: npm.version, sourceCommit: npmSourceCommit, platformPackage: npmPlatform, ...npmArchives };
}

function buildCargo(id: Exclude<AddedCandidate, "ts-rust">, root: string, distribution: string): CargoSource {
  const spec = registry[id].acquisition.cargo;
  const repo = repos[id];
  const git = spec?.git;
  if (!spec || !git || git.url !== `https://github.com/${repo}` || !/^[a-f0-9]{40}$/.test(git.ref)) throw new Error("Invalid pinned Cargo source");
  const words = spec.command.split(" ");
  if (words[0] !== "cargo" || words[1] !== "build" || !words.includes("--release") || !words.includes("--locked") ||
      !words.every((word) => /^[\w.-]+$/.test(word)) || spec.bin !== `target/release/${compilerPath[id]}`) throw new Error("Invalid pinned Cargo build command");
  const source = join(root, "source"), target = join(root, "target"), home = join(root, "home");
  mkdirSync(source); mkdirSync(home);
  const env = {
    PATH: "/usr/bin:/bin", HOME: home, LC_ALL: "C.UTF-8", TZ: "UTC", CI: spec.env?.CI ?? "true",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    CARGO_HOME: join(root, "cargo"), CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: "0", CARGO_BUILD_JOBS: "4",
    CARGO_ENCODED_RUSTFLAGS: `--remap-path-prefix=${root}=/build/tsc-compa`,
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(process.env.HOME!, ".rustup"),
  };
  const buildImage = process.env.ImageVersion;
  if (process.env.ImageOS !== "ubuntu24" || !buildImage || !/^\d[\w.-]{1,63}$/.test(buildImage)) throw new Error("Cargo public builds require the Ubuntu 24.04 hosted build profile");
  exec("git", ["init", "-q"], source, env);
  exec("git", ["fetch", "--depth=1", "--no-tags", git.url, git.ref], source, env);
  exec("git", ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "FETCH_HEAD"], source, env);
  if (exec("git", ["rev-parse", "HEAD"], source, env) !== git.ref || exec("git", ["status", "--porcelain"], source, env)) throw new Error("Cargo checkout does not match the pinned source");
  const rustup = Bun.which("rustup");
  if (!rustup) throw new Error("Install the pinned Rust toolchain before planning");
  const rustc = exec(rustup, ["run", rustToolchain, "rustc", "--version"], source, env);
  const cargo = exec(rustup, ["run", rustToolchain, "cargo", "--version"], source, env);
  if (rustc !== rustcVersion || !/^cargo 1\.99\.1 \([a-f0-9]+ \d{4}-\d\d-\d\d\)$/.test(cargo)) throw new Error("Unexpected Rust build toolchain");
  const linker = exec("cc", ["-dumpfullversion"], source, env);
  const lockPath = join(source, "Cargo.lock");
  const lockSha256 = digestFile(lockPath);
  const build = spawnSync(rustup, ["run", rustToolchain, ...words], { cwd: source, env, stdio: "inherit", timeout: 25 * 60_000 });
  if (build.status !== 0 || digestFile(lockPath) !== lockSha256) throw new Error(`Pinned Cargo build failed: ${build.error ?? build.status}`);
  mkdirSync(distribution);
  // Both pinned Cargo checkers embed their declaration bytes. tsz can also
  // search arbitrary on-disk installs; force embedded mode for every call.
  copyFileSync(join(target, "release", compilerPath[id]), join(distribution, compilerPath[id]));
  return { kind: "cargo", repository: repo, commit: git.ref, lockSha256, rustc, cargo, linker, buildImage };
}

export function prepareDistribution(id: AddedCandidate, dir: string): PreparedSource {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The pinned public distributions require Linux x64");
  dir = resolve(dir);
  mkdirSync(dirname(dir), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "tsc-public-build-"));
  try {
    const source = id === "ts-rust" ? acquireNpm(root, dir) : buildCargo(id, root, dir);
    chmodSync(join(dir, compilerPath[id]), 0o755);
    return source;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function distributionContents(id: AddedCandidate, dir: string) {
  const files = fileTree(dir);
  const binary = files.find(([path]) => path === compilerPath[id]);
  if (!binary) throw new Error("Compiler executable is missing from the public distribution");
  if (id === "ts-rust" && (!files.some(([path]) => path === "lib/lib.es5.d.ts") || binary[1] !== npmNativeSha256)) {
    throw new Error("Unexpected ts-rust native distribution");
  }
  if (id !== "ts-rust" && files.length !== 1) throw new Error("Unexpected files beside the standalone Cargo compiler");
  return { bin: join(resolve(dir), binary[0]), executable: binary[1], distribution: hash(files) };
}

function runtimeLibrariesSha256(bin: string): string {
  const result = spawnSync("ldd", [bin], { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  if (/^\s*(?:not a dynamic executable|statically linked)\s*$/.test(`${result.stdout}${result.stderr}`)) return hash([]);
  if (result.status !== 0) throw new Error("Cannot identify the compiler's Linux runtime libraries");
  const libraries: [string, string][] = [];
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    if (/^\s*linux-vdso\.so\.1\s/.test(line)) continue;
    const match = /^\s*(?:(\S+) => )?(\/[^\s]+) \(0x[\da-f]+\)\s*$/.exec(line);
    if (!match) throw new Error(`Unresolved compiler runtime library: ${line}`);
    libraries.push([match[1] ?? match[2]!.split("/").at(-1)!, digestFile(match[2]!)]);
  }
  return hash(libraries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function inspectDistribution(id: AddedCandidate, dir: string, source: PreparedSource, expected?: { executable: string; distribution: string; runtimeLibrariesSha256: string }) {
  const files = distributionContents(id, dir);
  if (expected && (files.executable !== expected.executable || files.distribution !== expected.distribution)) throw new Error("Prepared compiler bytes changed after planning");
  // actions/download-artifact drops executable permissions. Restore only the
  // checked entry point, after checking every distributed file's bytes.
  chmodSync(files.bin, 0o755);
  const libraries = runtimeLibrariesSha256(files.bin);
  if (expected && libraries !== expected.runtimeLibrariesSha256) throw new Error("Compiler runtime libraries changed after planning");
  const environment = candidateEnv(id);
  verifyVersion(id, files.bin);
  return { ...files, prepared: { source, runtimeLibrariesSha256: libraries, environment }, cliArgs: registry[id].cliArgs };
}

export function probeDistribution(id: AddedCandidate, tools: ReturnType<typeof inspectDistribution>) {
  const root = mkdtempSync(join(tmpdir(), "tsc-public-probe-"));
  try {
    writeFileSync(join(root, "probe.ts"), 'const m: Map<string, number> = new Map();\nconst n: Promise<number> = Promise.resolve(m.size);\ndocument.createElement("span");\n');
    const result = spawnSync(tools.bin, ["--noEmit", "--pretty", "false", "--target", "es2022", ...tools.cliArgs, "probe.ts"], {
      cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, LC_ALL: "C.UTF-8", ...tools.prepared.environment }, encoding: "utf8", timeout: 10_000,
    });
    if (result.status !== 0 || result.stdout.trim() || result.stderr.trim()) {
      throw new Error(`Standalone ${id} compiler could not load its default libraries: ${result.stdout}${result.stderr}${result.error ?? ""}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Public data uses a strict path-free shape, including the evaluated runtime
// policy. No command string, local path, or arbitrary environment is promoted.
const validString = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
const isObject = (v: unknown, keys: string) => typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.keys(v).sort().join(" ") === keys.split(" ").sort().join(" ");
export function validPrepared(id: AddedCandidate, prepared: PreparedEvidence, cliArgs: readonly string[]) {
  if (!isObject(prepared, "source runtimeLibrariesSha256 environment") || !validString(prepared.runtimeLibrariesSha256, /^[a-f0-9]{64}$/) ||
      hash(prepared.environment) !== hash(candidateEnv(id)) || hash(cliArgs) !== hash(registry[id].cliArgs)) return false;
  const source = prepared.source;
  if (id === "ts-rust") return isObject(source, "kind package version sourceCommit platformPackage launcherSha256 platformSha256") &&
    source.kind === "npm" && source.package === "tsc-rs" && source.version === addedCandidate(id).version &&
    source.sourceCommit === npmSourceCommit && source.platformPackage === npmPlatform &&
    source.launcherSha256 === npmArchives.launcherSha256 && source.platformSha256 === npmArchives.platformSha256;
  return isObject(source, "kind repository commit lockSha256 rustc cargo linker buildImage") && source.kind === "cargo" &&
    source.repository === repos[id] && source.commit === registry[id].acquisition.cargo?.git?.ref &&
    validString(source.lockSha256, /^[a-f0-9]{64}$/) && source.rustc === rustcVersion &&
    validString(source.cargo, /^cargo 1\.99\.1 \([a-f0-9]+ \d{4}-\d\d-\d\d\)$/) && validString(source.linker, /^\d+(?:\.\d+){1,2}$/) &&
    validString(source.buildImage, /^\d[\w.-]{1,63}$/);
}
