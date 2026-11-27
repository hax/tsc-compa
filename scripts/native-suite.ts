// Trusted public Release input only. The resolving job never executes the asset;
// the suite job re-fetches by the same asset ID and verifies the resolved bytes.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { loadBaselines, REPO_ROOT } from "../src/baselines.ts";

const BASELINES = ["7.1.0-beta", "6.0.3", "5.9.3"] as const;
const config = loadBaselines();
const TIMEOUT_MS = 5 * 60_000;
const ASSET_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

type Env = Record<string, string | undefined>;
type Request = ReturnType<typeof parseNativeRequest>;

class NativeInputError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new NativeInputError("Expected a JSON object");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, fallback = ""): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") throw new NativeInputError(`Invalid ${field}`);
  return value;
}

function identifier(value: unknown, field: string, max = 255): string {
  const name = text(value, field);
  if (name.length > max || !/^[A-Za-z0-9]/.test(name) || /[^A-Za-z0-9._-]/.test(name)) {
    throw new NativeInputError(`Invalid or missing ${field}`);
  }
  return name;
}

function checksum(value: unknown, field: string): string {
  const hex = text(value, field).toLowerCase();
  if (hex.length !== 64 || /[^a-f0-9]/.test(hex)) throw new NativeInputError(`Invalid ${field}`);
  return hex;
}

export function parseNativeRequest(eventName: string, event: unknown) {
  const payload = record(event);
  const automatic = eventName === "repository_dispatch";
  if (!automatic && eventName !== "workflow_dispatch") throw new NativeInputError("Unsupported native-suite event");
  if (automatic && payload.action !== "checker-binary") throw new NativeInputError("Unexpected repository_dispatch type");
  const input = record(automatic ? payload.client_payload : payload.inputs);
  if (text(input.binary_url, "binary_url") !== "") throw new NativeInputError("binary_url is no longer supported; use a same-repository Release asset");
  const implementation = identifier(text(input.implementation, "implementation", "checker"), "implementation", 80);
  const sourceSha = text(input.source_sha, "source_sha").toLowerCase();
  if (sourceSha && (!((sourceSha.length >= 7 && sourceSha.length <= 40) || sourceSha.length === 64) || /[^a-f0-9]/.test(sourceSha))) {
    throw new NativeInputError("Invalid source_sha");
  }
  if (text(input.platform, "platform", "linux-x64") !== "linux-x64") throw new NativeInputError("Only linux-x64 is supported");
  const tag = identifier(input.release_tag, "release_tag");
  const asset = identifier(input.asset_name, "asset_name");
  const baselineId = text(input.baseline, "baseline", "7.1.0-beta");
  const baseline = BASELINES.find((id) => id === baselineId);
  if (!baseline) throw new NativeInputError("Unsupported native baseline");
  const mode = automatic ? "fixed" : text(input.mode, "mode", "fixed");
  if (mode !== "fixed" && mode !== "official") throw new NativeInputError("Invalid mode");
  const limitText = automatic ? "0" : text(input.limit, "limit", "0");
  const limit = Number(limitText);
  if (/[^0-9]/.test(limitText) || !Number.isSafeInteger(limit)) throw new NativeInputError("limit must be a non-negative integer");
  const sha256 = text(input.sha256, "sha256") ? checksum(input.sha256, "sha256") : null;
  return { implementation, sourceSha: sourceSha || null, tag, asset, baseline, mode, limit, sha256 };
}

function assetId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new NativeInputError("Invalid Release asset ID");
  }
  return value;
}

function assetSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value >= 2 ** 31) {
    throw new NativeInputError("Invalid Release asset size");
  }
  return value;
}

export function selectReleaseAsset(releaseResponse: unknown, request: Request) {
  const release = record(releaseResponse);
  if (release.tag_name !== request.tag || release.draft !== false || !Array.isArray(release.assets)) {
    throw new NativeInputError("Expected the exact published Release tag");
  }
  const assets = release.assets.map(record).filter((asset) => asset.name === request.asset);
  const [asset] = assets;
  if (assets.length !== 1 || !asset || asset.state !== "uploaded") throw new NativeInputError("Expected exactly one uploaded asset with the requested name");
  const digest = text(asset.digest, "Release digest");
  if (digest && !digest.startsWith("sha256:")) throw new NativeInputError("Unsupported Release digest");
  const releaseSha256 = digest ? checksum(digest.slice(7), "Release digest") : null;
  if (releaseSha256 && request.sha256 && releaseSha256 !== request.sha256) throw new NativeInputError("Provided SHA-256 does not match the Release digest");
  return { assetId: assetId(asset.id), size: assetSize(asset.size), releaseSha256 };
}

function repoPath(repo: string): string {
  const parts = repo.split("/");
  if (parts.length !== 2) throw new NativeInputError("Invalid workflow repository");
  return parts.map((part) => identifier(part, "workflow repository")).join("/");
}

async function fetchReleaseAsset(fetcher: typeof fetch, repo: string, id: number): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
  // The name only selects the asset at resolution time. Bind both downloads
  // to its ID and never send authorization or use URLs supplied by the caller.
  let url = new URL(`https://api.github.com/repos/${repoPath(repo)}/releases/assets/${assetId(id)}`);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop < 4; hop++) {
    const headers = hop === 0 ? { Accept: "application/octet-stream", "X-GitHub-Api-Version": "2022-11-28" } : undefined;
    const response = await fetcher(url, { redirect: "manual", signal, headers });
    if (response.status === 200 && response.body) {
      const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (hop === 0 && (type === "application/json" || type?.endsWith("+json"))) {
        await response.body.cancel();
        throw new NativeInputError("Release asset API returned JSON instead of bytes; refusing a name-based download");
      }
      return response.body;
    }
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status)) throw new NativeInputError(`Release asset download failed (HTTP ${response.status})`);
    const location = response.headers.get("location");
    if (!location) throw new NativeInputError("Missing Release asset redirect");
    url = new URL(location, url);
    if (url.protocol !== "https:" || !ASSET_HOSTS.has(url.hostname) || url.port || url.username || url.password) {
      throw new NativeInputError("Unexpected Release asset redirect");
    }
  }
  throw new NativeInputError("Too many Release asset redirects");
}

export async function verifyReleaseAsset(
  repo: string, id: number, size: number, expected: string | null, destination?: string, fetcher = fetch,
): Promise<string> {
  const body = await fetchReleaseAsset(fetcher, repo, id);
  const hash = createHash("sha256");
  let received = 0;
  async function* checkedBytes() {
    for await (const chunk of body) {
      received += chunk.byteLength;
      if (received > size) throw new NativeInputError("Release asset size does not match");
      hash.update(chunk);
      yield chunk;
    }
  }
  if (destination === undefined) {
    for await (const _ of checkedBytes()) { /* Only hash bytes in the retrieval job. */ }
  } else {
    await pipeline(checkedBytes(), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  }
  if (received !== size) throw new NativeInputError("Release asset size does not match");
  const actual = hash.digest("hex");
  if (expected && actual !== expected) throw new NativeInputError("Release asset SHA-256 does not match");
  return actual;
}

export async function resolveRelease(repo: string, request: Request, token: string, fetcher = fetch) {
  const url = `https://api.github.com/repos/${repoPath(repo)}/releases/tags/${request.tag}`;
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new NativeInputError(`Release lookup failed (HTTP ${response.status})`);
  const { assetId, size, releaseSha256 } = selectReleaseAsset(await response.json(), request);
  const binarySha256 = await verifyReleaseAsset(repo, assetId, size, request.sha256 ?? releaseSha256, undefined, fetcher);
  return { request, assetId, size, binarySha256, releaseDigestVerified: releaseSha256 !== null };
}

type Plan = Awaited<ReturnType<typeof resolveRelease>>;

type ProcessStatus = { status: "ok" } | { status: "spawn-error" | "terminated" } | { status: "exit"; exitCode: number };
type RunStatus = { harness: ProcessStatus | { status: "missing-corpus" }; fallbackReport?: ProcessStatus };

function runBun(args: string[], env: Env): Promise<ProcessStatus> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env, stdio: "ignore" });
    child.once("error", () => resolve({ status: "spawn-error" }));
    child.once("close", (code) => resolve(code === 0 ? { status: "ok" }
      : code === null ? { status: "terminated" } : { status: "exit", exitCode: code }));
  });
}

async function runNativeHarness(plan: Plan, bin: string, corpus: string, out: string, env: Env): Promise<RunStatus> {
  const { request, assetId, binarySha256, releaseDigestVerified } = plan;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "provenance.json"), `${JSON.stringify({
    sourceSha: request.sourceSha,
    assetId,
    binarySha256,
    providedDigestVerified: request.sha256 !== null,
    releaseDigestVerified,
  }, null, 2)}\n`);
  // Do not pass the event, runner write paths, tokens, or npm/git configuration
  // to the harness or checker. This is not a sandbox: the binary must be trusted.
  const home = join(dirname(bin), "home");
  mkdirSync(home);
  const childEnv = { HOME: home, PATH: env.PATH, CHECKER_BATCH_BIN: bin, TMPDIR: env.TMPDIR };
  const args = [
    "--baseline", request.baseline, "--corpus", corpus, "--adapter", "checker-batch",
    "--mode", request.mode, "--report-impl-name", request.implementation, "--out", out, "--report-out", out,
    ...(request.limit === 0 ? [] : ["--limit", String(request.limit)]),
  ];
  // Report artifacts can contain raw checker output; do not echo it to the job
  // log (where it could also be interpreted as Actions workflow commands).
  const harness = statSync(corpus, { throwIfNoEntry: false })?.isDirectory()
    ? await runBun(["src/run.ts", ...args], childEnv) : { status: "missing-corpus" } as const;
  if (harness.status === "ok") return { harness };
  const fallbackReport = await runBun(["src/report.ts", "--from", out, "--out", out, "--impl-name", request.implementation], childEnv);
  return { harness, fallbackReport };
}

export async function executeNativePlan(repo: string, plan: Plan, corpus: string, out: string, env = process.env, fetcher = fetch): Promise<RunStatus> {
  const staging = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), "tsc-compa-native-"));
  try {
    const bin = join(staging, "checker");
    await verifyReleaseAsset(repo, plan.assetId, assetSize(plan.size), checksum(plan.binarySha256, "resolved SHA-256"), bin, fetcher);
    chmodSync(bin, 0o700);
    const result = await runNativeHarness(plan, bin, corpus, out, env);
    writeFileSync(join(out, "run-status.json"), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new NativeInputError(`Missing ${name}`);
  return value;
}

async function main(command: string | undefined) {
  const repo = required("GITHUB_REPOSITORY");
  if (command === "resolve") {
    const request = parseNativeRequest(required("GITHUB_EVENT_NAME"), JSON.parse(readFileSync(required("GITHUB_EVENT_PATH"), "utf8")));
    const baseline = config.baselines.find((baseline) => baseline.id === request.baseline);
    const corpus = baseline && config.corpora[baseline.corpus];
    if (corpus?.repo !== "microsoft/TypeScript") throw new NativeInputError("Unexpected corpus repository");
    const plan = await resolveRelease(repo, request, required("GH_TOKEN"));
    appendFileSync(required("GITHUB_OUTPUT"), `plan=${JSON.stringify(plan)}\ncorpus_ref=${corpus.ref}\n`);
  } else if (command === "run") {
    // The plan is a single-line JSON output of the successful retrieval job,
    // not a dispatch input. Never pass its fields through shell interpolation.
    const plan = JSON.parse(required("NATIVE_PLAN")) as Plan;
    const result = await executeNativePlan(repo, plan, resolve(REPO_ROOT, "reference/corpus/tests/cases"), resolve(REPO_ROOT, "out/native-suite"));
    if (result.harness.status !== "ok") {
      // Only allowlisted status codes and numeric process exit codes reach logs.
      console.error(`Native harness failed: ${JSON.stringify(result.harness)}`);
      if (result.fallbackReport && result.fallbackReport.status !== "ok") {
        console.error(`Native fallback report failed: ${JSON.stringify(result.fallbackReport)}`);
      }
      process.exitCode = 1;
    }
  } else {
    throw new NativeInputError("Usage: bun scripts/native-suite.ts resolve|run");
  }
}

if (import.meta.main) {
  main(process.argv[2]).catch((error: unknown) => {
    // Fetch/parse/filesystem errors may embed URLs, event data or local paths.
    // Only show our constant validation errors and numeric HTTP statuses.
    console.error(error instanceof NativeInputError ? error.message : "Native suite setup or Release download failed");
    process.exitCode = 1;
  });
}
