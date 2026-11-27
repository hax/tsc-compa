import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_ROOT = join(import.meta.dir, "..");

interface Registry {
  schemaVersion: number;
  implementations: Record<
    string,
    {
      displayName: string;
      adapter: string;
      kind?: string;
      tsVersion?: string;
      acquisition: {
        npm?: { package: string; version: string; bin: string };
        cargo?: { repo: string; command: string; bin: string };
        release?: { repo: string; version: string; tag: string; url: string; bin: string; fallbackBin?: string };
        localEnv?: string;
      };
      cliArgs?: string[];
      baselines: string[];
      phaseMetrics?: { flag: string; checkField: string };
    }
  >;
}

function loadRegistry(): Registry {
  return JSON.parse(readFileSync(join(REPO_ROOT, "config", "implementations.json"), "utf8")) as Registry;
}

function baselineIds(): Set<string> {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, "config", "baselines.json"), "utf8")) as {
    baselines: Array<{ id: string }>;
  };
  return new Set(config.baselines.map((b) => b.id));
}

describe("config/implementations.json", () => {
  test("登记表结构合法，基线引用都存在", () => {
    const registry = loadRegistry();
    const ids = baselineIds();
    expect(registry.schemaVersion).toBe(1);
    const names = Object.keys(registry.implementations);
    expect(names.length).toBeGreaterThan(0);
    for (const [name, impl] of Object.entries(registry.implementations)) {
      expect(name.length).toBeGreaterThan(0);
      // TSC 兼容实现通过公开 CLI 驱动；Bun 内置检查器使用专用 bun-check adapter。
      expect(["tsc-cli", "bun-check"]).toContain(impl.adapter);
      if (impl.adapter === "bun-check") expect(impl.kind).toBe("native");
      else expect(impl.kind ?? "tsc-compatible").toBe("tsc-compatible");
      const { npm, cargo, release, localEnv } = impl.acquisition;
      expect(npm !== undefined || cargo !== undefined || release !== undefined || localEnv !== undefined).toBe(true);
      if (npm !== undefined) {
        expect(npm.package.length).toBeGreaterThan(0);
        expect(npm.version.length).toBeGreaterThan(0);
        expect(npm.bin.length).toBeGreaterThan(0);
      }
      if (cargo !== undefined) {
        expect(cargo.repo.length).toBeGreaterThan(0);
        expect(cargo.command.length).toBeGreaterThan(0);
        expect(cargo.bin.length).toBeGreaterThan(0);
      }
      if (release !== undefined) {
        expect(release.repo).toBe("oven-sh/bun");
        expect(release.version.length).toBeGreaterThan(0);
        expect(release.tag).toContain(release.version);
        expect(release.url).toContain("{platform}");
        expect(release.bin).toContain("{platform}");
      }
      expect(impl.baselines.length).toBeGreaterThan(0);
      for (const id of impl.baselines) expect(ids.has(id)).toBe(true);
      // cliArgs 是扁平参数表（如 ["--checkers", "1"]），只校验都是非空字符串。
      for (const arg of impl.cliArgs ?? []) expect(arg.length).toBeGreaterThan(0);
    }
  });

  test("Bun 1.4.4 / 1.4.5 登记为 native 检查器而非运行器版本", () => {
    for (const [name, tag] of [["bun-check-1.4.4", "bun-v1.4.4"], ["bun-check-1.4.5", "bun-v1.4.5"]] as const) {
      const impl = loadRegistry().implementations[name];
      expect(impl).toBeDefined();
      expect(impl!.adapter).toBe("bun-check");
      expect(impl!.kind).toBe("native");
      expect(impl!.tsVersion).toBe("7.0.2 (embedded)");
      expect(impl!.acquisition.release?.tag).toBe(tag);
      expect(impl!.acquisition.localEnv).toBe("BUN_CHECK_BIN");
      expect(impl!.phaseMetrics?.flag).toBe("--timing");
    }
    const impl = loadRegistry().implementations["bun-check-1.4.5"];
    expect(impl).toBeDefined();
    expect(impl!.adapter).toBe("bun-check");
    expect(impl!.kind).toBe("native");
    expect(impl!.tsVersion).toBe("7.0.2 (embedded)");
    expect(impl!.acquisition.release?.tag).toBe("bun-v1.4.5");
    expect(impl!.acquisition.localEnv).toBe("BUN_CHECK_BIN");
    expect(impl!.phaseMetrics?.flag).toBe("--timing");
  });

  test("tsrs 登记了 npm 获取方式与相位字段", () => {
    const impl = loadRegistry().implementations["tsrs"];
    expect(impl).toBeDefined();
    expect(impl!.acquisition.npm?.package).toBe("tsrs");
    expect(impl!.phaseMetrics?.checkField).toBe("Check time");
  });
});
