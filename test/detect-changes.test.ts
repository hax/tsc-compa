import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  collectExternal,
  collectExternalPins,
  collectNpmPins,
  decideRun,
  hashLocalInputs,
  renderSummary,
  type DetectCurrent,
  type DetectState,
  type FetchJson,
} from "../scripts/detect-changes.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "detect-changes.ts");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 构造一份最小的仓库输入夹具：config/** + package.json + bun.lock。 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tsc-compa-detect-"));
  tempDirs.push(root);
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      {
        devDependencies: {
          "typescript-6-0": "npm:typescript@6.0.3",
          "typescript-7-1": "npm:typescript@7.1.0-beta",
          loose: "npm:foo@^1.2.3",
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, "bun.lock"), '{"lockfileVersion":1}\n');
  writeFileSync(
    join(root, "config", "baselines.json"),
    `${JSON.stringify({ corpora: { strada: { repo: "microsoft/TypeScript", ref: "abc123" } }, baselines: [] }, null, 2)}\n`,
  );
  writeFileSync(
    join(root, "config", "implementations.json"),
    `${JSON.stringify(
      {
        implementations: {
          "tsc-rs": {
            acquisition: { cargo: { git: { url: "https://github.com/kazhiramatsu/tsc-rs.git", ref: "2b006e0abc" } } },
          },
          tsrs: { acquisition: { npm: { package: "tsrs", version: "0.25.0-ts7.1.0-beta" } } },
        },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

function current(overrides: Partial<DetectCurrent> = {}): DetectCurrent {
  return { headSha: "sha-current", localHash: "hash-current", external: {}, info: {}, unavailable: [], ...overrides };
}

function previousState(overrides: Partial<DetectState> = {}): DetectState {
  return { version: 1, headSha: "sha-current", localHash: "hash-current", external: {}, info: {}, ...overrides };
}

describe("hashLocalInputs", () => {
  test("config/** 与 lockfile 的内容变化都会改变哈希", () => {
    const root = makeRoot();
    const before = hashLocalInputs(root);
    expect(before).toMatch(/^[0-9a-f]{64}$/);

    writeFileSync(join(root, "config", "smoke-cases.json"), "[]\n");
    const afterConfig = hashLocalInputs(root);
    expect(afterConfig).not.toBe(before);

    writeFileSync(join(root, "bun.lock"), '{"lockfileVersion":2}\n');
    expect(hashLocalInputs(root)).not.toBe(afterConfig);
  });

  test("哈希与文件遍历顺序无关、只跟内容有关", () => {
    const root = makeRoot();
    const first = hashLocalInputs(root);
    expect(hashLocalInputs(root)).toBe(first);
  });
});

describe("外部 pin 收集", () => {
  test("npm alias、implementations npm 版本、语料 ref、cargo git pin", () => {
    const root = makeRoot();
    const npm = collectNpmPins(root);
    expect(npm.pins.map((p) => p.key)).toEqual([
      "npm:tsrs@0.25.0-ts7.1.0-beta",
      "npm:typescript@6.0.3",
      "npm:typescript@7.1.0-beta",
    ]);
    expect(npm.skipped.join()).toContain("foo@^1.2.3"); // 范围版本不可比对

    const external = collectExternalPins(root);
    expect(external.pins.corpora.map((p) => p.key)).toEqual(["corpus:microsoft/TypeScript@abc123"]);
    expect(external.pins.implRepos.map((p) => p.key)).toEqual(["impl:kazhiramatsu/tsc-rs@2b006e0abc"]);
    expect(external.pins.upstreamRepos.map((r) => r.key)).toEqual([
      "upstream:kazhiramatsu/tsc-rs",
      "upstream:microsoft/TypeScript",
    ]);
  });

  test("非精确 npm 版本与非 GitHub 获取方式明确标记为不可比对", () => {
    const root = makeRoot();
    writeFileSync(
      join(root, "config", "implementations.json"),
      `${JSON.stringify({ implementations: { tsz: { acquisition: { cargo: { git: { url: "https://gitlab.com/x/tsz", ref: "abc" } } } } } })}\n`,
    );
    const external = collectExternalPins(root);
    expect(external.pins.implRepos).toEqual([]);
    expect(external.skipped.join()).toContain("gitlab.com");
  });
});

describe("collectExternal", () => {
  const pins = {
    npm: [{ key: "npm:typescript@6.0.3", package: "typescript", version: "6.0.3" }],
    corpora: [{ key: "corpus:microsoft/TypeScript@v5.9.3", repo: "microsoft/TypeScript", ref: "v5.9.3" }],
    implRepos: [{ key: "impl:owner/repo@abc", owner: "owner", repo: "repo", ref: "abc" }],
    upstreamRepos: [{ key: "upstream:owner/repo", owner: "owner", repo: "repo" }],
  };

  test("可查项记录 integrity / commit，缺失记 missing，网络失败记 unavailable", async () => {
    const fake: FetchJson = async (url) => {
      if (url.includes("registry.npmjs.org/typescript/6.0.3")) {
        return { status: 200, body: { dist: { integrity: "sha512-AAA" } } };
      }
      if (url.includes("/repos/microsoft/TypeScript/commits/v5.9.3")) {
        return { status: 200, body: { sha: "c63de15" } };
      }
      if (url.includes("/repos/owner/repo/commits/abc")) return { status: 404, body: null };
      if (url.includes("/repos/owner/repo/commits?per_page=1")) return { status: 200, body: [{ sha: "head123" }] };
      return null; // 其余视为网络不可用
    };
    const snapshot = await collectExternal(pins, { fetchJson: fake });
    expect(snapshot.values["npm:typescript@6.0.3"]).toBe("integrity:sha512-AAA");
    expect(snapshot.values["corpus:microsoft/TypeScript@v5.9.3"]).toBe("commit:c63de15");
    expect(snapshot.values["impl:owner/repo@abc"]).toBe("missing:404");
    expect(snapshot.info["upstream:owner/repo"]).toBe("head123");
    expect(snapshot.unavailable).toEqual([]);
  });

  test("网络不可用时全部记 unavailable（视为未变化）", async () => {
    const snapshot = await collectExternal(pins, { fetchJson: async () => null });
    expect(Object.keys(snapshot.values)).toEqual([]);
    expect(snapshot.unavailable.sort()).toEqual([
      "corpus:microsoft/TypeScript@v5.9.3",
      "impl:owner/repo@abc",
      "npm:typescript@6.0.3",
    ]);
  });

  test("5xx / 限流等临时故障记 unavailable，不当成 pin 缺失（避免误触发重跑）", async () => {
    const fake: FetchJson = async (url) => {
      if (url.includes("registry.npmjs.org")) return { status: 503, body: null };
      if (url.includes("/commits/")) return { status: 403, body: null };
      return null;
    };
    const snapshot = await collectExternal(pins, { fetchJson: fake });
    expect(Object.keys(snapshot.values)).toEqual([]);
    expect(snapshot.unavailable.sort()).toEqual([
      "corpus:microsoft/TypeScript@v5.9.3",
      "impl:owner/repo@abc",
      "npm:typescript@6.0.3",
    ]);
  });
});

describe("decideRun", () => {
  test("push / pull_request 门禁事件总是跑", () => {
    for (const eventName of ["push", "pull_request"]) {
      const decision = decideRun({ eventName, force: false, previous: previousState(), current: current() });
      expect(decision.run).toBe(true);
    }
  });

  test("schedule：首次无状态 → 跑；状态一致 → 跳过", () => {
    expect(decideRun({ eventName: "schedule", force: false, previous: null, current: current() }).run).toBe(true);
    const unchanged = decideRun({ eventName: "schedule", force: false, previous: previousState(), current: current() });
    expect(unchanged.run).toBe(false);
    expect(unchanged.changes).toEqual([]);
  });

  test("schedule：HEAD / 本地哈希 / 外部 pin 任一变化 → 跑", () => {
    expect(decideRun({ eventName: "schedule", force: false, previous: previousState(), current: current({ headSha: "new-head" }) }).changes[0]).toContain(
      "仓库 HEAD 变化",
    );
    expect(
      decideRun({ eventName: "schedule", force: false, previous: previousState(), current: current({ localHash: "new-hash" }) }).changes[0],
    ).toContain("本地输入");
    const externalChange = decideRun({
      eventName: "schedule",
      force: false,
      previous: previousState({ external: { "npm:typescript@6.0.3": "integrity:A" } }),
      current: current({ external: { "npm:typescript@6.0.3": "integrity:B" } }),
    });
    expect(externalChange.run).toBe(true);
    expect(externalChange.changes[0]).toContain("外部 pin 变化");
  });

  test("schedule：新增外部 pin / 不可查项只记录、不触发", () => {
    const decision = decideRun({
      eventName: "schedule",
      force: false,
      previous: previousState(),
      current: current({ external: { "npm:new@1.0.0": "integrity:A" }, unavailable: ["corpus:x@y"] }),
    });
    expect(decision.run).toBe(false);
    expect(decision.notes.join()).toContain("首次记录");
    expect(decision.notes.join()).toContain("unavailable");
  });

  test("workflow_dispatch 默认走检测，force 强制跑", () => {
    expect(decideRun({ eventName: "workflow_dispatch", force: false, previous: previousState(), current: current() }).run).toBe(false);
    const forced = decideRun({ eventName: "schedule", force: true, previous: previousState(), current: current() });
    expect(forced.run).toBe(true);
    expect(forced.changes[0]).toContain("force");
  });

  test("上游默认分支新提交只提示、不触发", () => {
    const decision = decideRun({
      eventName: "schedule",
      force: false,
      previous: previousState({ info: { "upstream:owner/repo": "old" } }),
      current: current({ info: { "upstream:owner/repo": "new" } }),
    });
    expect(decision.run).toBe(false);
    expect(decision.notes.join()).toContain("上游有新提交");
  });
});

describe("renderSummary", () => {
  test("跳过与要跑两种结论都写清楚", () => {
    const skip = renderSummary({
      eventName: "schedule",
      force: false,
      current: current(),
      previous: previousState(),
      decision: { run: false, changes: [], notes: ["不可查项（unavailable，视为未变化）：x"] },
      skippedPins: [],
    });
    expect(skip).toContain("无变化，跳过套件");
    const run = renderSummary({
      eventName: "schedule",
      force: false,
      current: current(),
      previous: null,
      decision: { run: true, changes: ["没有上次成功后记录的状态（首次运行或缓存缺失）"], notes: [] },
      skippedPins: [],
    });
    expect(run).toContain("需要跑套件");
  });
});

describe("detect-changes CLI（本地模拟两种输入）", () => {
  function runCli(root: string, out: string, extra: string[]): { status: number | null; outputs: string; stdout: string } {
    const outputFile = join(root, `github-output-${Math.random().toString(16).slice(2)}.txt`);
    writeFileSync(outputFile, "");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    env.GITHUB_OUTPUT = outputFile;
    env.GITHUB_SHA = "fixed-head";
    delete env.FORCE;
    const result = spawnSync(process.execPath, [SCRIPT, "--root", root, "--out", out, "--offline", ...extra], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    return { status: result.status, outputs: readFileSync(outputFile, "utf8"), stdout: result.stdout ?? "" };
  }

  test("首次跑、无变化跳过、改输入再跑、force 强制跑", () => {
    const root = makeRoot();
    const out = join(root, ".detect");

    // 1) 无状态：需要跑套件
    const first = runCli(root, out, ["--event", "schedule"]);
    expect(first.status).toBe(0);
    expect(first.outputs).toContain("run=true");
    expect(readFileSync(join(out, "state.json"), "utf8")).toContain("fixed-head");

    // 2) 同输入再跑：跳过
    const second = runCli(root, out, ["--event", "schedule"]);
    expect(second.outputs).toContain("run=false");

    // 3) 改 config 文件：重新判定为有变化
    writeFileSync(join(root, "config", "smoke-cases.json"), '["compiler/a.ts"]\n');
    const third = runCli(root, out, ["--event", "schedule"]);
    expect(third.outputs).toContain("run=true");
    expect(third.outputs).toContain("本地输入");

    // 4) force：即使无变化也跑
    expect(runCli(root, out, ["--event", "schedule"]).outputs).toContain("run=false"); // 状态已被第 3 次更新
    expect(runCli(root, out, ["--event", "schedule", "--force"]).outputs).toContain("run=true");
  });

  test("push 事件不依赖状态、直接跑", () => {
    const root = makeRoot();
    const result = runCli(root, join(root, ".detect"), ["--event", "push"]);
    expect(result.outputs).toContain("run=true");
    expect(result.stdout).toContain("push 事件");
  });
});
