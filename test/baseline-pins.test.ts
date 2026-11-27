// 官方基线语料 pin 与 npm gitHead 对齐（#7）。
//
// 6.0.3 / 7.1.0-beta-official 的期望来自各自 npm 包对应提交里的官方基线，所以
// `config/baselines.json` 的语料 ref 必须等于该 npm 包 package.json 的 gitHead。
// CI workflow 不硬编码 pin，而是从 config 现场解析 ref；这里一并断言这一架构，
// 避免「配置换了 pin、CI 还拉旧语料」或「硬编码 SHA 跟不上配置」的漂移回来。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");

interface BaselineConfig {
  corpora: Record<string, { repo: string; ref: string; note?: string }>;
  baselines: Array<{ id: string; corpus: string }>;
}

function loadConfig(): BaselineConfig {
  return JSON.parse(readFileSync(join(REPO_ROOT, "config", "baselines.json"), "utf8")) as BaselineConfig;
}

function corpusOf(config: BaselineConfig, baselineId: string): { repo: string; ref: string; note?: string } {
  const def = config.baselines.find((b) => b.id === baselineId);
  if (def === undefined) throw new Error(`未知基线 ${baselineId}`);
  const corpus = config.corpora[def.corpus];
  if (corpus === undefined) throw new Error(`基线 ${baselineId} 引用了不存在的语料 ${def.corpus}`);
  return corpus;
}

/** 期望源为「npm 包同提交的官方基线」的基线 → 对应 npm alias 安装目录。 */
const OFFICIAL_PACKAGES: Array<{ baseline: string; packageJson: string; packageName: string }> = [
  { baseline: "6.0.3", packageJson: "node_modules/typescript-6-0/package.json", packageName: "typescript@6.0.3" },
  { baseline: "7.1.0-beta-official", packageJson: "node_modules/typescript-7-1/package.json", packageName: "typescript@7.1.0-beta" },
];

const PINNED_RE = /^[0-9a-f]{40}$/;

describe("官方基线语料 pin（#7）", () => {
  test("语料 ref 是 40 位提交 SHA，而不是可移动 tag", () => {
    const config = loadConfig();
    for (const { baseline } of OFFICIAL_PACKAGES) {
      const corpus = corpusOf(config, baseline);
      expect(corpus.repo).toBe("microsoft/TypeScript");
      expect(corpus.ref, `${baseline} 的语料 pin 形状不对`).toMatch(PINNED_RE);
      expect(corpus.note ?? "", `${baseline} 的语料 note 应记录 pin 的来源`).toContain("gitHead");
    }
  });

  test("语料 ref 等于对应 npm 包的 gitHead", () => {
    const config = loadConfig();
    for (const { baseline, packageJson, packageName } of OFFICIAL_PACKAGES) {
      const installed = JSON.parse(readFileSync(join(REPO_ROOT, packageJson), "utf8")) as {
        version: string;
        gitHead?: string;
      };
      expect(typeof installed.gitHead, `${packageName} 的 package.json 缺 gitHead`).toBe("string");
      expect(corpusOf(config, baseline).ref, `${baseline} 的语料 pin 与 ${packageName} gitHead 不一致`).toBe(
        installed.gitHead!,
      );
    }
  });

  test("6.0.3 与 7.1.0-beta 共用同一份 strada 语料 pin", () => {
    const config = loadConfig();
    expect(corpusOf(config, "7.1.0-beta").ref).toBe(corpusOf(config, "6.0.3").ref);
  });

  test("smoke workflow 从 config/baselines.json 现场解析语料 ref，不硬编码 SHA", () => {
    const file = "smoke.yml";
    const text = readFileSync(join(REPO_ROOT, ".github", "workflows", file), "utf8");
    expect(text, `${file} 应有「Resolve corpus ref」步骤`).toContain("Resolve corpus ref");
    expect(text, `${file} 应从 config/baselines.json 解析 ref`).toContain("config/baselines.json");
    expect(text, `${file} 不应硬编码 40 位提交 SHA（应从配置解析）`).not.toMatch(/[0-9a-f]{40}/);
  });
});
