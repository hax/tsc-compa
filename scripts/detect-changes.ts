// 变化检测：每日 cron 先跑这里，只有「输入变了」才跑冒烟套件（见 docs/CI.md）。
//
// 判定为「有变化」（需要跑套件）的信号：
// 1. 本地输入哈希：config/**（baselines / corpora / manifest / implementations /
//    ratchet）、package.json、bun.lock 的内容 SHA-256；
// 2. 仓库 HEAD 与上次「套件全部通过后」记录的 headSha 不同（即上次成功后又有新提交）；
// 3. 外部 pin 漂移：
//    - npm 固定版本（package.json 的 npm alias + implementations.json 的 npm 版本）：
//      registry 精确版本清单的 dist.integrity —— 重发布/撤包会变；
//    - 语料 pin（config/baselines.json 的 corpora.*.ref）：GitHub API 解析成 commit sha，
//      tag 被移动会变；
//    - 第三方实现的 cargo git pin：GitHub API 确认该 commit 仍存在；
//    网络不可用 / API 限流 / 非 GitHub 地址 → 标记 unavailable，按「未变化」处理。
//
// 只报告、不触发的情况：第三方仓库默认分支上游有新提交（pin 固定，被测输入没变）。
//
// 用法（CI 里由 detect job 调用；本地也可直接跑）：
//   GITHUB_EVENT_NAME=schedule GITHUB_SHA=$(git rev-parse HEAD) \
//     bun scripts/detect-changes.ts --out .cache/smoke-detect
//
// 输出：GITHUB_OUTPUT（run / local_hash / reason / unavailable）、
//       <out>/state.json（套件成功后由 record job 存缓存，作为下次对比基准）、
//       <out>/summary.md（job summary）。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const STATE_VERSION = 1;
export const STATE_FILENAME = "state.json";
export const SUMMARY_FILENAME = "summary.md";

/** 本地输入：整个 config/ 目录 + 锁文件（package.json 的 npm alias 版本也影响安装结果）。 */
export const LOCAL_INPUT_FILES = ["package.json", "bun.lock"];
export const LOCAL_INPUT_DIRS = ["config"];

export interface NpmPin {
  /** 形如 `npm:typescript@5.9.3`，同时作为状态里的键。 */
  key: string;
  package: string;
  version: string;
}

export interface CorpusPin {
  key: string;
  repo: string;
  ref: string;
}

export interface ImplRepoPin {
  key: string;
  owner: string;
  repo: string;
  ref: string;
}

export interface UpstreamRepoRef {
  key: string;
  owner: string;
  repo: string;
}

export interface ExternalPins {
  npm: NpmPin[];
  corpora: CorpusPin[];
  implRepos: ImplRepoPin[];
  upstreamRepos: UpstreamRepoRef[];
}

export interface ExternalSnapshot {
  /** 可查项的最新值；值变化即判定漂移。 */
  values: Record<string, string>;
  /** 本次查不到的外部项（网络/限流/非 GitHub 地址），按未变化处理。 */
  unavailable: string[];
  /** 只报告、不触发的外部信息（如上游默认分支 HEAD）。 */
  info: Record<string, string>;
}

export interface DetectState {
  version: number;
  updatedAt?: string;
  /** 上次套件全部通过时的仓库 HEAD。 */
  headSha?: string;
  localHash?: string;
  external?: Record<string, string>;
  info?: Record<string, string>;
  unavailable?: string[];
}

export interface DetectCurrent {
  headSha: string;
  localHash: string;
  external: Record<string, string>;
  info: Record<string, string>;
  unavailable: string[];
}

export interface DetectDecision {
  run: boolean;
  /** 触发套件运行的变化原因（空 = 无变化）。 */
  changes: string[];
  /** 不触发但对维护者有意义的说明（不可查项、上游新提交等）。 */
  notes: string[];
}

/** GitHub API 请求结果；null 表示网络不可用/超时。 */
export interface HttpResult {
  status: number;
  body: unknown | null;
}

export type FetchJson = (url: string, headers: Record<string, string>) => Promise<HttpResult | null>;

export interface ExternalOptions {
  fetchJson?: FetchJson;
  /** GitHub token（CI 里的 GITHUB_TOKEN），没有就匿名查询（有 60 次/小时限制）。 */
  githubToken?: string;
}

export function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) out.push(path);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/** 计算本地输入哈希：文件相对路径 + 内容，排序后 SHA-256。 */
export function hashLocalInputs(root: string): string {
  const hash = createHash("sha256");
  const entries: string[] = [];
  for (const file of LOCAL_INPUT_FILES) {
    const path = join(root, file);
    if (existsSync(path)) entries.push(path);
  }
  for (const dir of LOCAL_INPUT_DIRS) entries.push(...walkFiles(join(root, dir)));
  for (const path of entries.sort()) {
    const rel = relative(root, path).split("\\").join("/");
    hash.update(rel).update("\u0000");
    hash.update(readFileSync(path)).update("\u0000");
  }
  return hash.digest("hex");
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const NPM_ALIAS = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/;
/** 只认精确版本（不含 ^ ~ > < * x || - 等范围符），范围版本无法用于 pin 漂移比对。 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** 收集 npm 固定版本 pin：package.json 的 npm alias + implementations.json 的 npm 获取方式。 */
export function collectNpmPins(root: string): { pins: NpmPin[]; skipped: string[] } {
  const pins = new Map<string, NpmPin>();
  const skipped: string[] = [];
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = readJson(pkgPath) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
    for (const [name, spec] of Object.entries({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })) {
      const m = NPM_ALIAS.exec(spec);
      if (m === null) continue;
      const version = m[2]!;
      if (!EXACT_VERSION.test(version)) {
        skipped.push(`${name}=npm:${m[1]}@${version}（非精确版本，无法比对）`);
        continue;
      }
      const pkgName = m[1]!;
      const pin: NpmPin = { key: `npm:${pkgName}@${version}`, package: pkgName, version };
      pins.set(pin.key, pin);
    }
  }
  const implPath = join(root, "config/implementations.json");
  if (existsSync(implPath)) {
    const registry = readJson(implPath) as {
      implementations?: Record<string, { acquisition?: { npm?: { package?: string; version?: string } } }>;
    };
    for (const [name, impl] of Object.entries(registry.implementations ?? {})) {
      const npm = impl.acquisition?.npm;
      if (npm?.package === undefined || npm.version === undefined) continue;
      if (!EXACT_VERSION.test(npm.version)) {
        skipped.push(`impl ${name}: npm:${npm.package}@${npm.version}（非精确版本，无法比对）`);
        continue;
      }
      const pin: NpmPin = { key: `npm:${npm.package}@${npm.version}`, package: npm.package, version: npm.version };
      pins.set(pin.key, pin);
    }
  }
  return { pins: [...pins.values()].sort((a, b) => a.key.localeCompare(b.key)), skipped };
}

const GITHUB_URL = /^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/;

/** 收集外部 pin：语料 ref、第三方实现的 cargo git pin，以及只作报告的上游仓库。 */
export function collectExternalPins(root: string): { pins: ExternalPins; skipped: string[] } {
  const skipped: string[] = [];
  const corpora: CorpusPin[] = [];
  const implRepos: ImplRepoPin[] = [];
  const upstream = new Map<string, UpstreamRepoRef>();
  const baselinesPath = join(root, "config/baselines.json");
  if (existsSync(baselinesPath)) {
    const config = readJson(baselinesPath) as { corpora?: Record<string, { repo?: string; ref?: string }> };
    for (const [name, corpus] of Object.entries(config.corpora ?? {})) {
      if (corpus.repo === undefined || corpus.ref === undefined) continue;
      corpora.push({ key: `corpus:${corpus.repo}@${corpus.ref}`, repo: corpus.repo, ref: corpus.ref });
    }
  }
  const implPath = join(root, "config/implementations.json");
  if (existsSync(implPath)) {
    const registry = readJson(implPath) as {
      implementations?: Record<string, { acquisition?: { cargo?: { git?: { url?: string; ref?: string } } } }>;
    };
    for (const [name, impl] of Object.entries(registry.implementations ?? {})) {
      const git = impl.acquisition?.cargo?.git;
      if (git?.url === undefined || git.ref === undefined) continue;
      const m = GITHUB_URL.exec(git.url);
      if (m === null) {
        skipped.push(`impl ${name}: 非 GitHub 地址 ${git.url}（unavailable，视为未变化）`);
        continue;
      }
      const owner = m[1]!;
      const repo = m[2]!;
      implRepos.push({ key: `impl:${owner}/${repo}@${git.ref}`, owner, repo, ref: git.ref });
      const key = `upstream:${owner}/${repo}`;
      upstream.set(key, { key, owner, repo });
    }
  }
  for (const corpus of corpora) {
    const m = GITHUB_URL.exec(`https://github.com/${corpus.repo}`);
    if (m !== null) upstream.set(`upstream:${m[1]}/${m[2]}`, { key: `upstream:${m[1]}/${m[2]}`, owner: m[1]!, repo: m[2]! });
  }
  return {
    pins: {
      npm: [],
      corpora: corpora.sort((a, b) => a.key.localeCompare(b.key)),
      implRepos: implRepos.sort((a, b) => a.key.localeCompare(b.key)),
      upstreamRepos: [...upstream.values()].sort((a, b) => a.key.localeCompare(b.key)),
    },
    skipped,
  };
}

const GITHUB_API = "https://api.github.com";
const NPM_REGISTRY = "https://registry.npmjs.org";
const USER_AGENT = "tsc-compa-detect";

/** 真实网络实现：超时 8 秒，任何网络异常返回 null（调用方记为 unavailable）。 */
export function makeFetchJson(githubToken?: string): FetchJson {
  const githubHeaders: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": USER_AGENT,
  };
  if (githubToken !== undefined && githubToken.length > 0) githubHeaders.authorization = `Bearer ${githubToken}`;
  return async (url, headers) => {
    try {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(8_000) });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { status: response.status, body };
    } catch {
      return null;
    }
  };
}

/** 5xx / 429 / 403（限流）视为「本次查不到」：记 unavailable（视为未变化），不当成 pin 缺失。 */
const isTransientStatus = (status: number): boolean => status >= 500 || status === 429 || status === 403;

const shaOf = (body: unknown): string | null => {
  if (body !== null && typeof body === "object" && "sha" in body && typeof (body as { sha: unknown }).sha === "string") {
    return (body as { sha: string }).sha;
  }
  return null;
};

/** 查询外部 pin 的最新值。fetchJson 可注入，便于单测。 */
export async function collectExternal(pins: ExternalPins, options: ExternalOptions = {}): Promise<ExternalSnapshot> {
  const fetchJson = options.fetchJson ?? makeFetchJson(options.githubToken);
  const headers: Record<string, string> = {};
  const snapshot: ExternalSnapshot = { values: {}, unavailable: [], info: {} };
  const cache = new Map<string, HttpResult | null>();
  const ask = async (url: string): Promise<HttpResult | null> => {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;
    const result = await fetchJson(url, headers);
    cache.set(url, result);
    return result;
  };

  for (const pin of pins.npm) {
    const url = `${NPM_REGISTRY}/${pin.package.replace("/", "%2F")}/${encodeURIComponent(pin.version)}`;
    const result = await ask(url);
    if (result === null) {
      snapshot.unavailable.push(pin.key);
      continue;
    }
    if (result.status !== 200) {
      if (isTransientStatus(result.status)) snapshot.unavailable.push(pin.key);
      else snapshot.values[pin.key] = `missing:${result.status}`;
      continue;
    }
    const dist =
      result.body !== null && typeof result.body === "object" ? (result.body as { dist?: { integrity?: unknown; tarball?: unknown } }).dist : undefined;
    const integrity = dist !== undefined && typeof dist.integrity === "string" ? dist.integrity : undefined;
    const tarball = dist !== undefined && typeof dist.tarball === "string" ? dist.tarball : undefined;
    snapshot.values[pin.key] = `integrity:${integrity ?? tarball ?? "unknown"}`;
  }

  /** GitHub commit 查询：200 且能解析 sha → 记录 commit；404 等 → missing；网络/限流/坏响应 → unavailable。 */
  const recordGithubCommit = (key: string, result: HttpResult | null): void => {
    if (result === null || isTransientStatus(result.status)) {
      snapshot.unavailable.push(key);
      return;
    }
    const sha = result.status === 200 ? shaOf(result.body) : null;
    if (result.status === 200 && sha === null) {
      snapshot.unavailable.push(key);
      return;
    }
    snapshot.values[key] = sha !== null ? `commit:${sha}` : `missing:${result.status}`;
  };

  for (const corpus of pins.corpora) {
    recordGithubCommit(corpus.key, await ask(`${GITHUB_API}/repos/${corpus.repo}/commits/${encodeURIComponent(corpus.ref)}`));
  }

  for (const pin of pins.implRepos) {
    recordGithubCommit(pin.key, await ask(`${GITHUB_API}/repos/${pin.owner}/${pin.repo}/commits/${encodeURIComponent(pin.ref)}`));
  }

  for (const repo of pins.upstreamRepos) {
    const result = await fetchJson(`${GITHUB_API}/repos/${repo.owner}/${repo.repo}/commits?per_page=1`, {});
    if (result === null || result.status !== 200 || !Array.isArray(result.body)) continue;
    const sha = shaOf(result.body[0]);
    if (sha !== null) snapshot.info[repo.key] = sha;
  }

  const sortRecord = (record: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
  snapshot.values = sortRecord(snapshot.values);
  snapshot.info = sortRecord(snapshot.info);
  snapshot.unavailable.sort((a, b) => a.localeCompare(b));
  return snapshot;
}

/**
 * 判定是否需要跑套件。
 *
 * - push / pull_request：门禁事件总是跑（每次提交都要有兼容性结论）；
 * - schedule / workflow_dispatch：变化驱动（force 跳过检测）；
 * - 首次没有上次成功记录（缓存缺失）视为有变化；
 * - 外部 pin 本次不可查时按未变化处理；首次记录的外部 pin 只登记、不触发。
 */
export function decideRun(input: {
  eventName: string;
  force: boolean;
  previous: DetectState | null;
  current: DetectCurrent;
}): DetectDecision {
  const changes: string[] = [];
  const notes: string[] = [];
  const gateEvent = input.eventName === "push" || input.eventName === "pull_request";

  if (input.force) changes.push("force 输入：跳过检测，强制跑套件");
  if (gateEvent) changes.push(`${input.eventName} 事件：门禁总是跑套件`);

  if (!gateEvent && !input.force) {
    const previous = input.previous;
    if (previous === null || previous.headSha === undefined || previous.localHash === undefined) {
      changes.push("没有上次成功后记录的状态（首次运行或缓存缺失）");
    } else {
      if (previous.headSha !== input.current.headSha) {
        changes.push(`仓库 HEAD 变化：${previous.headSha.slice(0, 12)} → ${input.current.headSha.slice(0, 12)}`);
      }
      if (previous.localHash !== input.current.localHash) {
        changes.push(
          `本地输入（config / package.json / bun.lock）哈希变化：${previous.localHash.slice(0, 12)} → ${input.current.localHash.slice(0, 12)}`,
        );
      }
      for (const [key, value] of Object.entries(input.current.external)) {
        const before = previous.external?.[key];
        if (before === undefined) {
          notes.push(`外部 pin 首次记录：${key}（不判定变化）`);
          continue;
        }
        if (before !== value) changes.push(`外部 pin 变化：${key}：${before} → ${value}`);
      }
      for (const key of Object.keys(previous.external ?? {})) {
        if (input.current.external[key] === undefined) notes.push(`外部 pin 本次未取到（视为未变化）：${key}`);
      }
    }
    if (input.current.unavailable.length > 0) {
      notes.push(`不可查项（unavailable，视为未变化）：${input.current.unavailable.join("、")}`);
    }
    for (const [key, value] of Object.entries(input.current.info)) {
      const before = input.previous?.info?.[key];
      if (before !== undefined && before !== value) {
        notes.push(`上游有新提交（pin 固定，不触发）：${key} ${before.slice(0, 12)} → ${value.slice(0, 12)}`);
      }
    }
  }

  return { run: changes.length > 0, changes, notes };
}

/** 读取上次成功状态；文件不存在或损坏返回 null（视为首次）。 */
export function readState(path: string): DetectState | null {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as DetectState;
    return state !== null && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

const escapeGithubOutput = (value: string): string => value.replace(/\r?\n/g, "；");

/** 渲染 job summary（Markdown）。 */
export function renderSummary(input: {
  eventName: string;
  force: boolean;
  current: DetectCurrent;
  decision: DetectDecision;
  previous: DetectState | null;
  skippedPins: string[];
}): string {
  const { current, decision, previous } = input;
  const lines = [
    "## 变化检测（cron 只在输入变化时跑套件）",
    "",
    `- 事件：\`${input.eventName}\`${input.force ? "（force）" : ""}`,
    `- 仓库 HEAD：\`${current.headSha.slice(0, 12)}\`` +
      (previous?.headSha !== undefined ? `（上次成功：\`${previous.headSha.slice(0, 12)}\`）` : "（无上次成功记录）"),
    `- 本地输入哈希：\`${current.localHash.slice(0, 16)}\``,
    `- 外部 pin：可查 ${Object.keys(current.external).length} 项，不可查 ${current.unavailable.length} 项`,
    "",
    decision.run ? `**需要跑套件**（${decision.changes.length} 个变化）：` : "**无变化，跳过套件**。",
    ...decision.changes.map((c) => `- ${c}`),
  ];
  if (decision.notes.length > 0) {
    lines.push("", "说明：", ...decision.notes.map((n) => `- ${n}`));
  }
  if (input.skippedPins.length > 0) {
    lines.push("", "不可比对的外部 pin：", ...input.skippedPins.map((s) => `- ${s}`));
  }
  return `${lines.join("\n")}\n`;
}

interface CliArgs {
  root: string;
  out: string;
  statePath: string;
  eventName: string;
  force: boolean;
  offline: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const repoRoot = resolve(import.meta.dir, "..");
  const out = join(process.cwd(), ".cache", "smoke-detect");
  const args: CliArgs = {
    root: repoRoot,
    out,
    statePath: join(out, STATE_FILENAME),
    eventName: process.env.GITHUB_EVENT_NAME ?? "local",
    force: process.env.FORCE === "true" || process.env.FORCE === "1",
    offline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} 需要一个值`);
      return value;
    };
    switch (arg) {
      case "--root":
        args.root = resolve(next());
        break;
      case "--out":
        args.out = resolve(next());
        args.statePath = join(args.out, STATE_FILENAME);
        break;
      case "--state":
        args.statePath = resolve(next());
        break;
      case "--event":
        args.eventName = next();
        break;
      case "--force":
        args.force = true;
        break;
      case "--offline":
        args.offline = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "用法：bun scripts/detect-changes.ts [--root <仓库根>] [--out <dir>] [--state <file>] " +
            "[--event <push|pull_request|schedule|workflow_dispatch>] [--force] [--offline]",
        );
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数 ${arg}`);
    }
  }
  return args;
}

function gitHead(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const previous = readState(args.statePath);
  const localHash = hashLocalInputs(args.root);
  const headSha = process.env.GITHUB_SHA ?? gitHead(args.root);

  const npmPins = collectNpmPins(args.root);
  const externalPins = collectExternalPins(args.root);
  const pins: ExternalPins = { ...externalPins.pins, npm: npmPins.pins };
  const skippedImplPins = [...npmPins.skipped, ...externalPins.skipped];

  let external: ExternalSnapshot = { values: {}, unavailable: [], info: {} };
  if (args.offline) {
    external.unavailable = [...pins.npm.map((p) => p.key), ...pins.corpora.map((p) => p.key), ...pins.implRepos.map((p) => p.key)];
  } else {
    external = await collectExternal(pins, { githubToken: process.env.GITHUB_TOKEN });
  }

  const current: DetectCurrent = {
    headSha,
    localHash,
    external: external.values,
    info: external.info,
    unavailable: external.unavailable,
  };
  const decision = decideRun({ eventName: args.eventName, force: args.force, previous, current });
  const state: DetectState = {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    headSha,
    localHash,
    external: external.values,
    info: external.info,
    unavailable: external.unavailable,
  };

  mkdirSync(args.out, { recursive: true });
  writeFileSync(args.statePath, `${JSON.stringify(state, null, 2)}\n`);
  const summary = renderSummary({ eventName: args.eventName, force: args.force, current, decision, previous, skippedPins: skippedImplPins });
  writeFileSync(join(args.out, SUMMARY_FILENAME), summary);

  console.log(`变化检测（event=${args.eventName}${args.force ? "，force" : ""}）`);
  console.log(`  仓库 HEAD：${headSha}`);
  console.log(`  上次成功：${previous?.headSha ?? "无记录"}`);
  console.log(`  本地输入哈希：${localHash}`);
  console.log(`  外部 pin：可查 ${Object.keys(current.external).length} 项，不可查 ${current.unavailable.length} 项`);
  for (const change of decision.changes) console.log(`  变化：${change}`);
  for (const note of decision.notes) console.log(`  说明：${note}`);
  for (const skipped of skippedImplPins) console.log(`  不可比对：${skipped}`);
  console.log(decision.run ? "判定：需要跑套件" : "判定：无变化，跳过套件");

  if (process.env.GITHUB_OUTPUT !== undefined) {
    const lines = [
      `run=${decision.run}`,
      `local_hash=${localHash}`,
      `reason=${escapeGithubOutput(decision.changes.join("；"))}`,
      `unavailable=${escapeGithubOutput(current.unavailable.join("；"))}`,
    ];
    writeFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, { flag: "a" });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
