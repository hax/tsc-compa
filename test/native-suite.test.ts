import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import { executeNativePlan, parseNativeRequest, resolveRelease, selectReleaseAsset, verifyReleaseAsset } from "../scripts/native-suite.ts";

// These fixtures start the harness, reference compiler, and synthetic checker
// in child processes. Leave room for process startup on a busy runner.
const HARNESS_TEST_TIMEOUT_MS = 30_000;

const repo = "example/compatibility";
const payload = {
  implementation: "checker",
  source_sha: "0123456789abcdef0123456789abcdef01234567",
  release_tag: "binary-checker-0123456-linux-x64",
  asset_name: "checker-0123456-linux-x64",
  platform: "linux-x64",
  baseline: "7.1.0-beta",
} as const;
const dispatch = (fields = {}) => parseNativeRequest("repository_dispatch", {
  action: "checker-binary", client_payload: { ...payload, ...fields },
});
const manual = (fields = {}) => parseNativeRequest("workflow_dispatch", { inputs: { ...payload, ...fields } });
const bytes = "synthetic checker bytes\n";
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const sha = hash(bytes);
const asset = { name: payload.asset_name, state: "uploaded", size: bytes.length, digest: `sha256:${sha}` };
const release = { tag_name: payload.release_tag, draft: false, assets: [asset] };

function mockFetch(callback: (url: string, options: RequestInit) => Response): typeof fetch {
  return Object.assign(async (input: Parameters<typeof fetch>[0], options: RequestInit = {}) => callback(String(input), options), {
    preconnect: fetch.preconnect,
  });
}

test("legacy automatic inputs keep all three baselines and fixed full-smoke defaults", () => {
  expect(dispatch({ mode: "official", limit: 2, adapter: "tsc-cli" })).toEqual({
    implementation: payload.implementation, sourceSha: payload.source_sha,
    tag: payload.release_tag, asset: payload.asset_name, baseline: payload.baseline,
    mode: "fixed", limit: 0, sha256: null,
  });
  for (const baseline of ["7.1.0-beta", "6.0.3", "5.9.3"] as const) {
    expect(dispatch({ baseline }).baseline).toBe(baseline);
  }
  expect(dispatch({ baseline: undefined }).baseline).toBe("7.1.0-beta");
  expect(manual({ mode: "official", limit: "2", sha256: sha.toUpperCase() })).toMatchObject({ mode: "official", limit: 2, sha256: sha });
});

test("only expected event, literal release inputs, and legacy baseline scope are accepted", () => {
  expect(() => parseNativeRequest("pull_request", {})).toThrow("event");
  expect(() => parseNativeRequest("repository_dispatch", { action: "other", client_payload: payload })).toThrow("type");
  for (const [field, bad] of [
    ["release_tag", "v1/*"], ["release_tag", "--help"], ["release_tag", "foo\nplan=bad"],
    ["asset_name", "../checker"], ["asset_name", "*"], ["asset_name", "checker[1]"], ["asset_name", "foo%2fbar"],
    ["asset_name", "checker\n"], ["asset_name", ""], ["asset_name", "checker;cmd"],
    ["implementation", "foo/bar"], ["source_sha", "sha\n"], ["platform", "linux-arm64"],
    ["baseline", "7.1.0-beta-official"], ["sha256", `${sha}\n`], ["sha256", {}],
    ["binary_url", "https://example.com/checker"],
  ] as const) expect(() => dispatch({ [field]: bad })).toThrow();
  for (const limit of ["-1", "1e2", "0x2", " 2", "1 --gate", "9007199254740992"]) expect(() => manual({ limit })).toThrow("limit");
  expect(() => manual({ binary_url: "https://example.com/private" })).toThrow("no longer supported");
  expect(() => manual({ mode: "other" })).toThrow("mode");
});

test("Release lookup requires the exact published tag and one exact uploaded asset", () => {
  const request = dispatch();
  expect(selectReleaseAsset({ ...release, assets: [{ ...asset, name: `${asset.name}.bak` }, asset] }, request))
    .toEqual({ size: bytes.length, releaseSha256: sha });
  expect(selectReleaseAsset({ ...release, assets: [{ ...asset, digest: null }] }, request).releaseSha256).toBeNull();
  expect(() => selectReleaseAsset({ ...release, tag_name: "v0" }, request)).toThrow("tag");
  expect(() => selectReleaseAsset({ ...release, draft: true }, request)).toThrow("published");
  for (const assets of [[{ ...asset, name: asset.name.toUpperCase() }], [asset, asset], [{ ...asset, state: "open" }]]) {
    expect(() => selectReleaseAsset({ ...release, assets }, request)).toThrow("exactly one");
  }
  expect(() => selectReleaseAsset({ ...release, assets: [{ ...asset, digest: "sha256:invalid" }] }, request)).toThrow("digest");
  expect(() => selectReleaseAsset(release, dispatch({ sha256: "a".repeat(64) }))).toThrow("does not match");
});

test("retrieval hashes legacy assets; only metadata request carries authorization", async () => {
  const urls: string[] = [];
  const fetcher = mockFetch((url, opts) => {
    urls.push(url);
    if (url.startsWith("https://api.github.com/")) {
      expect(new Headers(opts.headers).get("Authorization")).toBe("Bearer test-token");
      expect(opts.redirect).toBe("error");
      return Response.json({ ...release, assets: [{ ...asset, digest: undefined, browser_download_url: "https://bad.example/ignored" }] });
    }
    expect(new Headers(opts.headers).has("Authorization")).toBe(false);
    expect(opts.redirect).toBe("manual");
    if (url.startsWith("https://github.com/")) return Response.redirect("https://release-assets.githubusercontent.com/test?opaque=token");
    return new Response(bytes);
  });
  const plan = await resolveRelease(repo, dispatch(), "test-token", fetcher);
  expect(plan).toMatchObject({ binarySha256: sha, releaseDigestVerified: false });
  expect(urls).toEqual([
    `https://api.github.com/repos/${repo}/releases/tags/${payload.release_tag}`,
    `https://github.com/${repo}/releases/download/${payload.release_tag}/${payload.asset_name}`,
    "https://release-assets.githubusercontent.com/test?opaque=token",
  ]);
  expect(await resolveRelease(repo, dispatch({ sha256: sha }), "test-token", fetcher)).toMatchObject({ binarySha256: sha });
  await expect(resolveRelease(repo, dispatch({ sha256: "b".repeat(64) }), "test-token", fetcher)).rejects.toThrow("SHA-256");
  const changed = mockFetch((url) => url.startsWith("https://api.github.com/") ? Response.json(release) : new Response("x".repeat(bytes.length)));
  await expect(resolveRelease(repo, dispatch(), "test-token", changed)).rejects.toThrow("SHA-256");
});

test("execution download rejects off-host, plaintext, URL credentials and changed or oversized bytes", async () => {
  const request = dispatch();
  for (const url of ["https://bad.example/", "http://release-assets.githubusercontent.com/", "https://user@release-assets.githubusercontent.com/", "https://release-assets.githubusercontent.com:1234/"]) {
    await expect(verifyReleaseAsset(repo, request, bytes.length, sha, undefined,
      mockFetch(() => new Response(null, { status: 302, headers: { Location: url } }))),
    ).rejects.toThrow("Unexpected Release asset redirect");
  }
  for (const [body, error] of [[`${bytes}x`, "size"], ["x", "size"], ["x".repeat(bytes.length), "SHA-256"]] as const) {
    await expect(verifyReleaseAsset(repo, request, bytes.length, sha, undefined, mockFetch(() => new Response(body))))
      .rejects.toThrow(error);
  }
});

test("verified synthetic batch executable produces the four standard reports and provenance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tsc-compa-native-test-"));
  try {
    const corpus = join(dir, "tests/cases");
    const out = join(dir, "reports");
    const selected = join(corpus, "compiler/2dArrays.ts");
    mkdirSync(dirname(selected), { recursive: true });
    writeFileSync(selected, "var x = 1;\n");
    // Check the environment from both --version and the batch tool. If anything
    // leaks, the fixture exits before returning a version or checking a case.
    const checker = `#!${process.execPath}\n${String.raw`
      if (process.env.GH_TOKEN || process.env.GITHUB_ENV || process.env.NATIVE_PLAN) process.exit(3);
      if (process.argv.includes("--version")) { console.log("Synthetic checker 1"); process.exit(0); }
      if (!process.argv.includes("--batch")) process.exit(4);
      const { createInterface } = await import("node:readline");
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        if (request.type === "shutdown") break;
        console.log(JSON.stringify({ protocol: 1, type: "result", id: request.id, status: "ok", diagnostics: [], fullText: "", exitCode: 0 }));
      }
    `}`;
    const digest = hash(checker);
    const request = manual({ baseline: "7.1.0-beta", limit: "1", sha256: digest });
    const plan = { request, size: Buffer.byteLength(checker), binarySha256: digest, releaseDigestVerified: true };
    expect(await executeNativePlan(repo, plan, corpus, out, {
      ...process.env, GH_TOKEN: "synthetic-token", GITHUB_ENV: "synthetic-env", NATIVE_PLAN: "synthetic-plan",
    }, mockFetch(() => new Response(checker)))).toBe(true);
    const read = (name: string) => readFileSync(join(out, name), "utf8");
    const metrics = JSON.parse(read("metrics.json"));
    expect(metrics.meta).toMatchObject({ baseline: "7.1.0-beta", adapter: "checker-batch", mode: "fixed", verdictEligible: false, selectedCases: 1 });
    expect(metrics.meta.tools.candidate).toMatchObject({ sha256: digest, version: "Synthetic checker 1" });
    expect(metrics.skips).toEqual([]);
    expect(metrics.totals.ran).toBe(1);
    expect(JSON.parse(read("details.json"))).toHaveLength(1);
    expect(read("report.md")).toContain("checker");
    expect(read("report.html")).toContain("<!doctype html>");
    expect(JSON.parse(read("provenance.json"))).toEqual({ sourceSha: payload.source_sha, binarySha256: digest, providedDigestVerified: true, releaseDigestVerified: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, HARNESS_TEST_TIMEOUT_MS);

test("native harness failure produces a fallback report but not false success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tsc-compa-native-failure-"));
  try {
    const checker = "#!/bin/sh\nexit 2\n";
    const out = join(dir, "reports");
    const plan = { request: manual({ limit: "1" }), size: checker.length, binarySha256: hash(checker), releaseDigestVerified: false };
    expect(await executeNativePlan(repo, plan, join(dir, "missing-corpus"), out, process.env, mockFetch(() => new Response(checker)))).toBe(false);
    expect(existsSync(join(out, "metrics.json"))).toBe(false);
    expect(readFileSync(join(out, "report.md"), "utf8")).toContain("metrics.json");
    expect(readFileSync(join(out, "report.html"), "utf8")).toContain("metrics.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, HARNESS_TEST_TIMEOUT_MS);

test("a mismatched download never starts the checker and is removed from staging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tsc-compa-native-mismatch-"));
  try {
    const marker = join(dir, "started");
    const checker = `#!/bin/sh\ntouch '${marker}'\n`;
    const out = join(dir, "reports");
    const plan = { request: dispatch(), size: checker.length, binarySha256: "c".repeat(64), releaseDigestVerified: false };
    await expect(executeNativePlan(repo, plan, join(dir, "missing-corpus"), out,
      { ...process.env, RUNNER_TEMP: dir }, mockFetch(() => new Response(checker)),
    )).rejects.toThrow("SHA-256");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a per-case checker crash stays visible in the standard non-gating reports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tsc-compa-native-crash-"));
  try {
    const corpus = join(dir, "tests/cases");
    mkdirSync(join(corpus, "compiler"), { recursive: true });
    writeFileSync(join(corpus, "compiler/2dArrays.ts"), "var x = 1;\n");
    const checker = "#!/bin/sh\nexit 2\n";
    const out = join(dir, "reports");
    const plan = { request: manual({ limit: "1" }), size: checker.length, binarySha256: hash(checker), releaseDigestVerified: false };
    expect(await executeNativePlan(repo, plan, corpus, out, process.env, mockFetch(() => new Response(checker)))).toBe(true);
    const metrics = JSON.parse(readFileSync(join(out, "metrics.json"), "utf8"));
    expect(metrics.meta.executionFailures).toMatchObject([{ side: "candidate", status: "crash" }]);
    expect(existsSync(join(out, "report.html"))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, HARNESS_TEST_TIMEOUT_MS);
