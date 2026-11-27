// Read-only public evaluation of pinned third-party CLI distributions.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { baseline, verifyVersion } from "./full-compatibility.ts";
import { fileTree } from "./public-evaluation-inputs.ts";
import { REPO_ROOT } from "../src/baselines.ts";
import { sha256 } from "../src/provenance.ts";

import { activePolicies, rustToolchain, type AddedCandidate, type PreparedSource } from "./public-evaluation-policy.ts";

const compilerPath = { "ts-rust": "lib/tsc", "tsc-rs": "tsc-rs", tsz: "tsz" } as const;

type Implementation = {
  displayName: string; adapter: string; baselines: string[]; cliArgs: string[];
  acquisition: {
    npm?: { package: string; version: string };
    cargo?: { git?: { url: string; ref: string }; command: string; bin: string; env?: { CI: string } };
  };
};
function implementation(id: AddedCandidate): Implementation {
  const specs = JSON.parse(readFileSync(join(REPO_ROOT, "config/implementations.json"), "utf8")).implementations as Record<AddedCandidate, Implementation>;
  const spec = specs[id];
  const { candidate, cliArgs, source } = activePolicies[id];
  const acquisition = spec.acquisition;
  if (spec.adapter !== "tsc-cli" || !spec.baselines.includes(baseline) || spec.displayName !== candidate.name ||
      JSON.stringify(spec.cliArgs) !== JSON.stringify(cliArgs) ||
      (source.kind === "npm" ? acquisition.npm?.package !== source.package || acquisition.npm.version !== source.version
        : acquisition.cargo?.git?.url !== `https://github.com/${source.repository}` || acquisition.cargo.git.ref !== source.commit)) {
    throw new Error(`Registry differs from the active public policy for ${id}`);
  }
  return spec;
}

const exec = (exe: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) => execFileSync(exe, args, {
  cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 60_000,
}).trim();
const digestFile = (file: string) => sha256(readFileSync(file));
const hash = (value: unknown) => sha256(JSON.stringify(value));
type NpmSource = Extract<PreparedSource, { kind: "npm" }>;
type CargoSource = Extract<PreparedSource, { kind: "cargo" }>;

export function verifyNpmArchive(bytes: Uint8Array, digest: string, integrity: string) {
  if (sha256(bytes) !== digest || `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) {
    throw new Error("Pinned npm archive integrity mismatch");
  }
}

function acquireNpm(root: string, distribution: string): NpmSource {
  const policy = activePolicies["ts-rust"];
  const npm = policy.source;
  if (npm.kind !== "npm" || !("npmIntegrity" in policy)) throw new Error("Missing ts-rust npm policy");
  const download = (url: string, digest: string, integrity: string, dest: string) => {
    const archive = join(root, `${digest}.tgz`);
    exec("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https", "--retry", "3", "-o", archive, url]);
    verifyNpmArchive(readFileSync(archive), digest, integrity);
    mkdirSync(dest, { recursive: true });
    exec("tar", ["--extract", "--gzip", "--file", archive, "--directory", dest, "--strip-components=1", "--no-same-owner"]);
  };
  const modules = join(root, "node_modules");
  const launcher = join(modules, npm.package);
  const nativePackage = join(modules, npm.platformPackage);
  download(`https://registry.npmjs.org/${npm.package}/-/${npm.package}-${npm.version}.tgz`, npm.launcherSha256, policy.npmIntegrity.launcher, launcher);
  download(`https://registry.npmjs.org/${npm.platformPackage}/-/linux-x64-${npm.version}.tgz`, npm.platformSha256, policy.npmIntegrity.platform, nativePackage);
  const metadata = (path: string) => JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  const cli = metadata(launcher), native = metadata(nativePackage);
  if (cli.name !== npm.package || cli.version !== npm.version || cli.optionalDependencies?.[npm.platformPackage] !== npm.version ||
      native.name !== npm.platformPackage || native.version !== npm.version) throw new Error("Unexpected ts-rust npm package metadata");
  const compiler = join(nativePackage, compilerPath["ts-rust"]);
  const resolved = exec("node", ["--input-type=module", "-e",
    "const {pathToFileURL}=await import('node:url'); const m=await import(pathToFileURL(process.argv[1])); console.log(m.default())",
    join(launcher, "lib/getExePath.js")], root);
  if (realpathSync(resolved) !== realpathSync(compiler) || digestFile(compiler) !== policy.nativeSha256) throw new Error("Unexpected ts-rust native executable");
  verifyVersion("ts-rust", join(launcher, "bin/tsc-rs"));
  // Preserve the platform package layout, not the JavaScript launcher. The
  // executable discovers sibling declaration files by its native location.
  cpSync(nativePackage, distribution, { recursive: true });
  return npm;
}

function buildCargo(id: Exclude<AddedCandidate, "ts-rust">, root: string, distribution: string): CargoSource {
  const spec = implementation(id).acquisition.cargo!;
  const pin = activePolicies[id].source;
  if (pin.kind !== "cargo") throw new Error("Invalid pinned Cargo source");
  const git = spec.git!;
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
  const rustcPath = exec(rustup, ["which", "--toolchain", rustToolchain, "rustc"], source, env);
  const cargoPath = exec(rustup, ["which", "--toolchain", rustToolchain, "cargo"], source, env);
  const rustc = exec(rustcPath, ["--version"], source, env);
  const cargo = exec(cargoPath, ["--version"], source, env);
  if (rustc !== pin.rustc || !/^cargo 1\.99\.1 \([a-f0-9]+ \d{4}-\d\d-\d\d\)$/.test(cargo)) throw new Error("Unexpected Rust build toolchain");
  const linker = exec("cc", ["-dumpfullversion"], source, env);
  const lockPath = join(source, "Cargo.lock");
  if (digestFile(lockPath) !== pin.lockSha256) throw new Error("Pinned Cargo.lock digest changed");
  const build = spawnSync(cargoPath, words.slice(1), { cwd: source, env: { ...env, PATH: `${dirname(rustcPath)}:${env.PATH}`, RUSTC: rustcPath }, stdio: "inherit", timeout: 25 * 60_000 });
  if (build.status !== 0 || digestFile(lockPath) !== pin.lockSha256) throw new Error(`Pinned Cargo build failed: ${build.error ?? build.status}`);
  mkdirSync(distribution);
  // Both pinned Cargo checkers embed their declaration bytes. tsz can also
  // search arbitrary on-disk installs; force embedded mode for every call.
  copyFileSync(join(target, "release", compilerPath[id]), join(distribution, compilerPath[id]));
  return { ...pin, cargo, linker, buildImage };
}

export function prepareDistribution(id: AddedCandidate, dir: string): PreparedSource {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("The pinned public distributions require Linux x64");
  implementation(id);
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
  const policy = activePolicies[id];
  if (id === "ts-rust" && (!files.some(([path]) => path === "lib/lib.es5.d.ts") || !("nativeSha256" in policy) || binary[1] !== policy.nativeSha256)) {
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
  const spec = implementation(id);
  const environment = activePolicies[id].environment;
  verifyVersion(id, files.bin);
  return { ...files, prepared: { source, runtimeLibrariesSha256: libraries, environment }, cliArgs: spec.cliArgs };
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
