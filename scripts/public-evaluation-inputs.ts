// Evidence for public runs: verify the bytes the harness will actually read,
// not just HEAD or git status (both can pass on an incomplete sparse checkout).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expandCaseVariants } from "../src/case.ts";
import { readCase } from "../src/discover.ts";
import { expectationFromOfficialBaseline, expectationFromOfficialVariantBaseline } from "../src/officialBaseline.ts";
import { sha256 } from "../src/provenance.ts";

const casesPath = "tsc/testdata/tests/cases";
const baselinePath = "tsc/testdata/baselines/reference";
const alternateBaselinePath = "tsc/testdata/tests/baselines/reference";

function git(path: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Could not read pinned Git tree: ${result.stderr || result.error}`);
  return result.stdout;
}

function directoriesAreReal(root: string, relative: string) {
  let current = root;
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    if (!lstatSync(current, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Missing or non-directory public input: ${relative}`);
  }
}

function visitFiles(root: string, prefix: string, visit: (relative: string, path: string) => void) {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) visitFiles(root, relative, visit);
    else if (entry.isFile()) visit(relative, join(root, relative));
    else throw new Error(`Non-regular public input: ${relative}`);
  }
}

export function verifyCorpus(dir: string, ref: string): string {
  const root = resolve(dir);
  if (git(root, "rev-parse", "HEAD").trim() !== ref) throw new Error("Corpus is not at its pinned commit");
  // The generic harness checks the TS6 layout first; never let even an
  // ignored/untracked alternate directory shadow the real TS7 baseline.
  if (lstatSync(join(root, alternateBaselinePath), { throwIfNoEntry: false })) throw new Error("Unexpected alternate corpus baseline directory");
  for (const subtree of [casesPath, baselinePath]) {
    directoriesAreReal(root, subtree);
    const tree = new Map<string, string>();
    for (const entry of git(root, "ls-tree", "-r", "-z", ref, "--", subtree).split("\0").filter(Boolean)) {
      const match = /^(?:100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error(`Unexpected pinned corpus entry: ${entry}`);
      tree.set(match[2]!, match[1]!);
    }
    if (!tree.size) throw new Error(`Pinned corpus subtree is empty: ${subtree}`);
    visitFiles(root, subtree, (relative, path) => {
      const expected = tree.get(relative);
      if (!expected) throw new Error(`Untracked corpus input: ${relative}`);
      const bytes = readFileSync(path);
      const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (oid !== expected) throw new Error(`Corpus input differs from pinned bytes: ${relative}`);
      tree.delete(relative);
    });
    if (tree.size) throw new Error(`Missing tracked corpus input: ${tree.keys().next().value} (${tree.size} missing)`);
  }
  return join(root, casesPath);
}

export function shardInputEvidence(corpus: string, shard: string, ids: string[]) {
  const parsedInputs = createHash("sha256");
  const officialInputs = createHash("sha256");
  for (const id of ids) {
    const parsed = readCase(corpus, id);
    parsedInputs.update(`${JSON.stringify([id, parsed])}\n`);
    if (parsed.skip !== null || parsed.unknown.length) continue;
    const expanded = expandCaseVariants(parsed);
    if (expanded.status !== "ok") continue;
    for (const variant of expanded.variants) {
      // Match run.ts's official-baseline path, including zero-diagnostic
      // evidence encoded as null but not unsupported baselines.
      const official = variant.configName === "" ? expectationFromOfficialBaseline(corpus, id, parsed)
        : parsed.absoluteFiles.length || id.endsWith(".d.ts") ? null
        : expectationFromOfficialVariantBaseline(corpus, variant);
      if (official?.status === "ok") officialInputs.update(`${JSON.stringify([variant.variantId, official.text])}\n`);
    }
  }
  return { shard, parsedInputsSha256: parsedInputs.digest("hex"), officialInputsSha256: officialInputs.digest("hex") };
}
export type ShardInputEvidence = ReturnType<typeof shardInputEvidence>;

// Packages keep their default libraries beside their native binaries. Include
// the entire effective platform directory.
export function distributionSha256(directories: string[]): string {
  const distributions = directories.map((root) => {
    if (!existsSync(join(root, "package.json"))) throw new Error("Compiler distribution is missing its package metadata");
    const files: [string, string][] = [];
    visitFiles(root, "", (relative, path) => files.push([relative, sha256(readFileSync(path))]));
    files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return files;
  });
  return sha256(JSON.stringify(distributions));
}
