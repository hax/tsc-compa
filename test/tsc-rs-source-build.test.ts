import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { buildSourceBundle, sourcePin, verifySourceBuildBundle, type Docker } from "../scripts/tsc-rs-source-build.ts";
import { publicCatalog } from "../scripts/public-evaluation.ts";
import { sha256 } from "../src/provenance.ts";

const image = `docker.io/library/rust@sha256:${"a".repeat(64)}`;
const identity = ["rustc", "cargo"].map((tool) =>
  `tool: ${tool}\ncommit-hash: ${"b".repeat(40)}\nhost: x86_64-unknown-linux-gnu\nrelease: 1.93.0`).join("\n");
// Header only: it is deliberately not a runnable program.
const elf = Buffer.alloc(64);
elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
elf.writeUInt16LE(3, 16);
elf.writeUInt16LE(62, 18);
const fixture = (fn: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "source-build-test-"));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
function mapping(args: string[], target: string) {
  return args.find((item) => item.startsWith("type=bind,") && item.includes(`,target=/${target}`));
}
function output(args: string[], bytes: Buffer = elf) {
  const dest = mapping(args, "export")?.match(/^type=bind,source=(.*),target=\/export$/)?.[1];
  if (!dest) throw new Error("No export mount");
  writeFileSync(join(dest, "tsc-rs"), bytes);
}
const syntheticDocker: Docker = (args, { capture }) => {
  if (args.includes("--network=none")) output(args);
  return capture ? identity : "";
};

test("build preparation is credential-free by construction and only the acquisition stages can access the network", () => fixture((root) => {
  const out = join(root, "bundle");
  const run: Docker = (args, options) => {
    expect(Object.keys(options.env).sort()).toEqual(["DOCKER_CONFIG", "HOME", "LC_ALL", "PATH"]);
    expect(options.env.DOCKER_CONFIG).toBe(options.env.HOME);
    expect(readdirSync(options.env.HOME!)).toEqual(["config.json"]);
    expect(JSON.parse(readFileSync(join(options.env.HOME!, "config.json"), "utf8"))).toEqual({ auths: { "https://index.docker.io/v1/": {} } });
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--network=host");
    if (args[0] === "run") {
      expect(args).toEqual(expect.arrayContaining(["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pull=never",
        "--entrypoint=/usr/bin/env", image, "-i", "linux/amd64"]));
      expect(args[args.indexOf("--user") + 1]).toBe(`${process.getuid!()}:${process.getgid!()}`);
      const script = args.at(-1)!;
      expect(spawnSync("/bin/bash", ["-n"], { input: script, encoding: "utf8" }).status).toBe(0);
      if (args.includes("--network=none")) {
        expect(mapping(args, "source")?.endsWith(",readonly")).toBe(true);
        expect(script).toContain(" build --release --frozen --target ");
        expect(script).toContain("crates/compiler/Cargo.toml");
        expect(script).toContain("which --toolchain");
      } else {
        expect(mapping(args, "export")).toBeUndefined();
        expect(mapping(args, "target")).toBeUndefined();
        if (options.capture) {
          expect(mapping(args, "source")?.endsWith(",readonly")).toBe(true);
          expect(script).toContain(" fetch --locked --target ");
          expect(script).not.toContain(" build ");
        } else {
          for (const pin of [sourcePin.tagObject, sourcePin.commit, sourcePin.tree, sourcePin.cargoLockSha256, sourcePin.rustToolchainSha256]) {
            expect(script).toContain(pin);
          }
        }
      }
      expect(args.join(" ")).not.toContain("docker.sock");
    }
    return syntheticDocker(args, options);
  };
  const evidence = buildSourceBundle(out, image, run);
  expect(evidence.executableSha256).toBe(sha256(elf));
  expect(evidence.distributionSha256).toBe(sha256(JSON.stringify([["tsc-rs", sha256(elf)]])));
  expect(statSync(join(out, "compiler/tsc-rs")).mode & 0o111).toBe(0);
  expect(verifySourceBuildBundle(out, image, sha256(elf), sha256(readFileSync(join(out, "provenance.json"))))).toEqual(evidence);
  expect(publicCatalog().combinations.some(({ candidate }) => candidate.id === ("tsc-rs" as string))).toBe(false);
}));

test("fails closed on an unpinned image, invalid toolchain, failed compile or wrong architecture", () => fixture((root) => {
  const out = join(root, "bundle");
  expect(() => buildSourceBundle(out, "rust:1.93.0-bookworm", () => { throw new Error("must not call Docker"); })).toThrow("digest-pinned");
  expect(() => buildSourceBundle(out, image, () => identity.replaceAll("1.93.0", "1.94.0"))).toThrow("Unexpected Rust/Cargo");
  const calls: string[][] = [];
  expect(() => buildSourceBundle(out, image, (args, options) => {
    calls.push(args);
    if (args.includes("--network=none")) throw new Error("compile failed");
    return syntheticDocker(args, options);
  })).toThrow("compile failed");
  expect(calls.at(-1)?.slice(0, 2)).toEqual(["rm", "-f"]);
  expect(calls.at(-1)?.[2]).toBe(calls.at(-2)?.[3]);
  expect(() => buildSourceBundle(out, image, (args, options) => {
    if (args.includes("--network=none")) {
      const arm = Buffer.from(elf);
      arm.writeUInt16LE(183, 18);
      output(args, arm);
      return "";
    }
    return syntheticDocker(args, options);
  })).toThrow("Linux x64 ELF");
  expect(existsSync(out)).toBe(false);
}));

test("verification uses independent pins and rejects edited metadata, binaries, extra files and symlinks", () => fixture((root) => {
  const out = join(root, "bundle");
  const evidence = buildSourceBundle(out, image, syntheticDocker);

  const manifest = join(out, "provenance.json");
  const bin = join(out, "compiler/tsc-rs");
  const original = readFileSync(manifest);
  const verify = () => verifySourceBuildBundle(out, image, sha256(elf), sha256(original));
  expect(() => verifySourceBuildBundle(out, image, "", sha256(original))).toThrow("reviewed");
  expect(() => verifySourceBuildBundle(out, `docker.io/library/rust@sha256:${"c".repeat(64)}`, sha256(elf), sha256(original))).toThrow("provenance");
  for (const altered of [{ ...evidence, source: { ...sourcePin, commit: "0".repeat(40) } },
    { ...evidence, recipe: { ...evidence.recipe, sha256: "0".repeat(64) } },
    { ...evidence, toolchainIdentity: `${identity}\nprivate path` }, { ...evidence, extra: "not allowed" },
    { ...evidence, distributionSha256: "0".repeat(64) }]) {
    writeFileSync(manifest, JSON.stringify(altered));
    expect(verify).toThrow("provenance digest mismatch");
    expect(() => verifySourceBuildBundle(out, image, sha256(elf), sha256(readFileSync(manifest)))).toThrow("mismatch");
  }
  writeFileSync(manifest, original);
  const modified = Buffer.from(elf);
  modified[63] = 1;
  writeFileSync(bin, modified);
  expect(verify).toThrow("executable or distribution mismatch");
  writeFileSync(bin, elf);
  writeFileSync(join(out, "extra"), "unreviewed");
  expect(verify).toThrow("Unexpected source-build bundle contents");
  rmSync(join(out, "extra"));
  rmSync(bin);
  const linked = join(root, "file");
  writeFileSync(linked, elf);
  symlinkSync(linked, bin);
  expect(verify).toThrow("Invalid build output");
}));

test("acquisition shell checks a real local annotated tag, tree and lockfile without executing candidate code", () => fixture((root) => {
  const upstream = join(root, "upstream");
  const git = (args: string[]) => {
    const run = spawnSync("git", [...args], { env: { HOME: root, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
      encoding: "utf8", cwd: root });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  };
  git(["init", "--quiet", "--object-format=sha1", upstream]);
  writeFileSync(join(upstream, "Cargo.lock"), "# synthetic lock\n");
  writeFileSync(join(upstream, "rust-toolchain.toml"), "# synthetic toolchain file\n");
  const upstreamGit = (...args: string[]) => git(["-C", upstream, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", ...args]);
  upstreamGit("add", ".");
  upstreamGit("commit", "-qm", "synthetic sources");
  upstreamGit("tag", "-am", "synthetic tag", sourcePin.tag);
  const pins = {
    tagObject: upstreamGit("rev-parse", `${sourcePin.tag}^{tag}`),
    commit: upstreamGit("rev-parse", "HEAD"),
    tree: upstreamGit("rev-parse", "HEAD^{tree}"),
    cargoLockSha256: sha256(readFileSync(join(upstream, "Cargo.lock"))),
    rustToolchainSha256: sha256(readFileSync(join(upstream, "rust-toolchain.toml"))),
  };
  const run: Docker = (args, options) => {
    if (args[0] === "run" && args.includes("--network=bridge") && !options.capture) {
      const work = mapping(args, "source")!.match(/^type=bind,source=(.*),target=\/source$/)![1]!;
      const localScript = (badLock: boolean) => {
        let script = args.at(-1)!.replace("cd /source", `cd '${work}'`).replace(`https://github.com/${sourcePin.repository}.git`, `file://${upstream}`);
        for (const key of Object.keys(pins) as (keyof typeof pins)[]) {
          script = script.replaceAll(sourcePin[key], badLock && key === "cargoLockSha256" ? "0".repeat(64) : pins[key]);
        }
        // macOS ships shasum, whereas the actual builder runs GNU sha256sum.
        if (process.platform === "darwin") script = script.replace("sha256sum --check --status", "shasum -a 256 --check --status");
        return spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" } });
      };
      expect(localScript(true).status).toBe(1);
      const good = localScript(false);
      expect(good.stderr).toBe("");
      expect(good.status).toBe(0);
    }
    return syntheticDocker(args, options);
  };
  buildSourceBundle(join(root, "bundle"), image, run);
}));
