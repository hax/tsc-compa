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
      acquisition: { npm?: { package: string; version: string; bin: string }; cargo?: { repo: string; command: string; bin: string }; localEnv?: string };
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
      // 第三方实现只允许通过公开 CLI 驱动（tsc-cli 适配器），不写内部 adapter。
      expect(impl.adapter).toBe("tsc-cli");
      const { npm, cargo, localEnv } = impl.acquisition;
      expect(npm !== undefined || cargo !== undefined || localEnv !== undefined).toBe(true);
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
      expect(impl.baselines.length).toBeGreaterThan(0);
      for (const id of impl.baselines) expect(ids.has(id)).toBe(true);
      // cliArgs 是扁平参数表（如 ["--checkers", "1"]），只校验都是非空字符串。
      for (const arg of impl.cliArgs ?? []) expect(arg.length).toBeGreaterThan(0);
    }
  });

  test("tsrs 登记了 npm 获取方式与相位字段", () => {
    const impl = loadRegistry().implementations["tsrs"];
    expect(impl).toBeDefined();
    expect(impl!.acquisition.npm?.package).toBe("tsrs");
    expect(impl!.phaseMetrics?.checkField).toBe("Check time");
  });
});
