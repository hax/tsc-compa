// Standalone, unpromoted build recipe. Public evaluation deliberately does not import this module.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { sha256 } from "../src/provenance.ts";

const target = "x86_64-unknown-linux-gnu";
const toolchain = "1.93.0-x86_64-unknown-linux-gnu";
export const sourcePin = Object.freeze({
  kind: "source-build",
  repository: "kazhiramatsu/tsc-rs",
  tag: "v0.1.0",
  tagObject: "9fcaec53d235e1e04e452324d7ce4e18d60a6dc6",
  commit: "ed173ea362dcd2a6e3d34d508506573ce736d88b",
  tree: "018b5ec92aff391579cc77ead413f2ad0f410d6b",
  cargoLockSha256: "87c76d4e279d777cf6a4cbdae389462e77c0fa3b0089392e4f8746984b16528f",
  rustToolchainSha256: "fbd21d92d7dfb2ec38a4385a7541697d528ddd5dff4695619ba91f66a983f763",
} as const);
// This preparation stage has no approved builder digest yet. Require callers to
// provide the reviewed official Rust image by digest, never by a mutable tag.
function requireImage(image: string) {
  if (!/^docker\.io\/library\/rust@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("A digest-pinned official Rust image is required");
  return image;
}
const platform = "linux/amd64";
const binaryName = "tsc-rs";
const manifestPath = "crates/compiler/Cargo.toml";
const environment = [
  "PATH=/usr/local/cargo/bin:/usr/bin:/bin", "HOME=/tmp/build-home", "RUSTUP_HOME=/usr/local/rustup",
  "CARGO_HOME=/deps", "CARGO_TARGET_DIR=/target", "CARGO_INCREMENTAL=0", "LC_ALL=C", "TZ=UTC",
  "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0",
] as const;
const hardened = ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--hostname=tsc-source-builder",
  "--tmpfs=/tmp:rw,nosuid,nodev", "--platform", platform] as const;
const setup = `
set -euo pipefail
umask 022
mkdir -p "$HOME"
rustup=/usr/local/cargo/bin/rustup
export RUSTC="$("$rustup" which --toolchain '${toolchain}' rustc)"
export RUSTDOC="$("$rustup" which --toolchain '${toolchain}' rustdoc)"
cargo="$("$rustup" which --toolchain '${toolchain}' cargo)"
`;
const fetchSource = `
set -euo pipefail
umask 022
mkdir -p "$HOME"
cd /source
git init --quiet --template= --object-format=sha1
git -c core.hooksPath=/dev/null -c fetch.fsckObjects=true fetch --quiet --no-tags --depth=1 'https://github.com/${sourcePin.repository}.git' 'refs/tags/${sourcePin.tag}:refs/tags/${sourcePin.tag}'
test "$(git rev-parse 'refs/tags/${sourcePin.tag}^{tag}')" = '${sourcePin.tagObject}'
test "$(git rev-parse 'refs/tags/${sourcePin.tag}^{commit}')" = '${sourcePin.commit}'
test "$(git rev-parse '${sourcePin.commit}^{tree}')" = '${sourcePin.tree}'
git ls-tree -r '${sourcePin.commit}' | awk '$1 == "160000" { bad=1 } END { exit bad }'
git -c core.hooksPath=/dev/null -c core.autocrlf=false checkout --quiet --detach '${sourcePin.commit}'
printf '%s  %s\\n' '${sourcePin.cargoLockSha256}' Cargo.lock '${sourcePin.rustToolchainSha256}' rust-toolchain.toml | sha256sum --check --status
`;
const fetchDependencies = `${setup}
cd /source
"$cargo" fetch --locked --target '${target}' --manifest-path '${manifestPath}' >&2
for bin in "$RUSTC" "$cargo"; do
  printf 'tool: %s\\n' "\${bin##*/}"
  "$bin" --version --verbose | awk '
    /^commit-hash: / { commit=$0 }
    /^host: / { host=$0 }
    /^release: / { release=$0 }
    END { if (!commit || !host || !release) exit 1; print commit; print host; print release }'
done
`;
const compile = `${setup}
cd /source
"$cargo" build --release --frozen --target '${target}' --manifest-path '${manifestPath}' --bin '${binaryName}'
install -m 0755 -- '/target/${target}/release/${binaryName}' '/export/${binaryName}'
`;
const entrypoint = ["-i", ...environment, "/bin/bash", "-c"] as const;
const stages = [
  { network: "bridge", mounts: [["source", false]], command: fetchSource, timeout: 300_000, capture: false },
  { network: "bridge", mounts: [["source", true], ["deps", false]], command: fetchDependencies, timeout: 300_000, capture: true },
  { network: "none", mounts: [["source", true], ["deps", false], ["target", false], ["export", false]], command: compile, timeout: 1_200_000, capture: false },
] as const;
const recipeFor = (image: string) => Object.freeze({ image: requireImage(image), platform, target, toolchain,
  sha256: sha256(JSON.stringify([hardened, "/usr/bin/env", entrypoint, "non-root", stages])),
});

// Evidence is not signed and is not a public policy. A reviewed expected digest
// comes from outside the bundle; this copy of provenance cannot authorize itself.
export type BuildEvidence = {
  schemaVersion: 1;
  source: typeof sourcePin;
  recipe: ReturnType<typeof recipeFor>;
  toolchainIdentity: string;
  executableSha256: string;
  distributionSha256: string;
};
const expectedKeys = (actual: unknown, expected: readonly string[]): actual is Record<string, unknown> =>
  !!actual && typeof actual === "object" && !Array.isArray(actual) &&
  Object.keys(actual).length === expected.length && expected.every((key) => Object.hasOwn(actual, key));
const matches = (value: unknown, pin: Record<string, unknown>) => expectedKeys(value, Object.keys(pin)) &&
  Object.entries(pin).every(([key, expected]) => value[key] === expected);
const isDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function validToolchain(identity: unknown): identity is string {
  if (typeof identity !== "string") return false;
  const record = (tool: string) => `tool: ${tool}\ncommit-hash: [a-f0-9]{40}\nhost: ${target}\nrelease: 1\\.93\\.0`;
  return new RegExp(`^${record("rustc")}\n${record("cargo")}$`).test(identity);
}
function regularBytes(path: string, maxBytes: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > maxBytes) throw new Error(`Invalid build output: ${path}`);
  return readFileSync(path);
}
function inspectBinary(dir: string) {
  if (!lstatSync(dir).isDirectory() || readdirSync(dir).join() !== binaryName) throw new Error("Expected exactly one standalone tsc-rs executable");
  const bytes = regularBytes(resolve(dir, binaryName), 128 * 1024 * 1024);
  if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || bytes[4] !== 2 || bytes[5] !== 1 || bytes[6] !== 1 ||
      ![2, 3].includes(bytes.readUInt16LE(16)) || bytes.readUInt16LE(18) !== 62) throw new Error("Expected a Linux x64 ELF output");
  const digest = sha256(bytes);
  return { bytes, digest, distribution: sha256(JSON.stringify([[binaryName, digest]])) };
}

export function verifySourceBuildBundle(dir: string, image: string, expectedExecutableSha256: string, expectedProvenanceSha256: string): BuildEvidence {
  const recipe = recipeFor(image);
  if (!isDigest(expectedExecutableSha256) || !isDigest(expectedProvenanceSha256)) {
    throw new Error("Independently reviewed executable and provenance SHA-256 digests are required");
  }
  if (!lstatSync(dir).isDirectory() || readdirSync(dir).sort().join() !== "compiler,provenance.json") throw new Error("Unexpected source-build bundle contents");
  const bytes = regularBytes(resolve(dir, "provenance.json"), 4096);
  if (sha256(bytes) !== expectedProvenanceSha256) throw new Error("Source-build bundle provenance digest mismatch");
  const observed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!expectedKeys(observed, ["schemaVersion", "source", "recipe", "toolchainIdentity", "executableSha256", "distributionSha256"]) ||
      observed.schemaVersion !== 1 || !matches(observed.source, sourcePin) || !matches(observed.recipe, recipe) ||
      !validToolchain(observed.toolchainIdentity) || observed.executableSha256 !== expectedExecutableSha256) {
    throw new Error("Source-build bundle provenance or executable mismatch");
  }
  const { digest, distribution } = inspectBinary(resolve(dir, "compiler"));
  if (digest !== expectedExecutableSha256 || distribution !== observed.distributionSha256) throw new Error("Source-build bundle executable or distribution mismatch");
  return observed as BuildEvidence;
}

export type Docker = (args: string[], options: { env: NodeJS.ProcessEnv; capture: boolean; timeout: number }) => string;
const docker: Docker = (args, { env, capture, timeout }) => {
  const result = spawnSync("/usr/bin/docker", ["--host=unix:///var/run/docker.sock", ...args], {
    cwd: env.HOME, env, timeout, killSignal: "SIGKILL", encoding: "utf8", stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
  });
  if (result.status !== 0 || result.error) throw new Error(`Docker ${args[0]} failed: ${result.error ?? result.signal ?? result.status}`);
  return result.stdout ?? "";
};

export function buildSourceBundle(output: string, image: string, run: Docker = docker): BuildEvidence {
  const recipe = recipeFor(image);
  if (run === docker && (process.platform !== "linux" || process.arch !== "x64" || !process.getuid?.())) {
    throw new Error("Build on a disposable native Linux x64 runner as a non-root user with local Docker");
  }
  const out = resolve(output);
  if (lstatSync(out, { throwIfNoEntry: false })) throw new Error("Source-build output must not already exist");
  const parent = realpathSync(tmpdir());
  if (parent.includes(",")) throw new Error("Docker bind-mount staging path must not contain commas");
  const root = mkdtempSync(resolve(parent, "tsc-rs-build-"));
  try {
    for (const name of ["source", "deps", "target", "export", "home"]) mkdirSync(resolve(root, name));
    // An explicit empty Docker Hub auth entry prevents credential-helper auto-detection.
    writeFileSync(resolve(root, "home/config.json"), '{"auths":{"https://index.docker.io/v1/":{}}}\n', { flag: "wx", mode: 0o600 });
    const env = { HOME: resolve(root, "home"), DOCKER_CONFIG: resolve(root, "home"), PATH: "/usr/bin:/bin", LC_ALL: "C" };
    const invoke = (args: string[], timeout: number, capture = false) => run(args, { env, timeout, capture });
    const mount = (name: string, readonly = false) => ["--mount", `type=bind,source=${resolve(root, name)},target=/${name}${readonly ? ",readonly" : ""}`];
    const stage = ({ network, mounts, command, timeout, capture }: typeof stages[number]) => {
      const name = `tsc-rs-${randomUUID()}`;
      try {
        return invoke(["run", "--rm", "--name", name, "--pull=never", ...hardened, `--network=${network}`,
          "--user", `${process.getuid!()}:${process.getgid!()}`, ...mounts.flatMap(([dir, readonly]) => mount(dir, readonly)),
          "--entrypoint=/usr/bin/env", image, ...entrypoint, command], timeout, capture);
      } catch (error) {
        try { invoke(["rm", "-f", name], 15_000, true); } catch { /* Preserve the original error. */ }
        throw error;
      }
    };
    invoke(["pull", "--platform", platform, image], 300_000);
    stage(stages[0]);
    const toolchainIdentity = stage(stages[1]).trim();
    if (!validToolchain(toolchainIdentity)) throw new Error("Unexpected Rust/Cargo toolchain identity");
    stage(stages[2]);
    const { bytes, digest, distribution } = inspectBinary(resolve(root, "export"));
    const evidence: BuildEvidence = { schemaVersion: 1, source: sourcePin, recipe, toolchainIdentity, executableSha256: digest, distributionSha256: distribution };
    mkdirSync(out);
    try {
      mkdirSync(resolve(out, "compiler"));
      // Verifiers and future shard jobs restore execute permission only after checking the digest.
      writeFileSync(resolve(out, "compiler", binaryName), bytes, { flag: "wx", mode: 0o644 });
      writeFileSync(resolve(out, "provenance.json"), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
      return evidence;
    } catch (error) {
      rmSync(out, { recursive: true, force: true });
      throw error;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [command, output, image, digest, provenance, ...extra] = process.argv.slice(2);
  if (!output || !image || extra.length || (command === "verify" ? !digest || !provenance : command !== "build" || digest !== undefined)) {
    throw new Error("Usage: tsc-rs-source-build.ts build <new-output-dir> <rust-image-by-digest> | verify <bundle> <rust-image-by-digest> <reviewed-executable-sha256> <reviewed-provenance-sha256>");
  }
  const evidence = command === "build" ? buildSourceBundle(output, image) : verifySourceBuildBundle(output, image, digest!, provenance!);
  console.log(JSON.stringify(evidence, null, 2));
}
