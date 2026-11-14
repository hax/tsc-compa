#!/usr/bin/env bun
// 第三方实现获取器：按 config/implementations.json 拿到一个可执行文件路径。
//
// 用法：
//   bun scripts/install-impl.ts --name tsrs --dest .tools          # npm 预编译（CI 用）
//   bun scripts/install-impl.ts --name tsrs --source local          # 用 localEnv 指向的本地二进制
//   bun scripts/install-impl.ts --name tsrs --source cargo          # 只检查 cargo 产物是否就绪
//
// 最后一行向 stdout 打印可执行文件路径（相对当前目录；不在当前目录下则绝对路径）。
// 失败以非零退出并打印原因；不改变 reference/ 下的任何仓库。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dir, "..");

interface NpmAcquisition {
  package: string;
  version: string;
  bin: string;
}
interface CargoAcquisition {
  repo: string;
  command: string;
  bin: string;
}
interface Implementation {
  displayName: string;
  adapter: string;
  acquisition: {
    npm?: NpmAcquisition;
    cargo?: CargoAcquisition;
    localEnv?: string;
  };
}

function usage(): never {
  console.error("用法：bun scripts/install-impl.ts --name <impl> [--dest <dir>] [--source npm|local|cargo]");
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  let name = "";
  let dest = ".tools";
  let source = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) usage();
      return v;
    };
    switch (arg) {
      case "--name":
        name = next();
        break;
      case "--dest":
        dest = next();
        break;
      case "--source":
        source = next();
        break;
      default:
        usage();
    }
  }
  if (name.length === 0) usage();

  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "config", "implementations.json"), "utf8")) as {
    implementations: Record<string, Implementation>;
  };
  const impl = registry.implementations[name];
  if (impl === undefined) {
    console.error(`未知实现 ${name}；可用：${Object.keys(registry.implementations).join(" / ")}`);
    process.exit(1);
  }
  const { npm, cargo, localEnv } = impl.acquisition;

  const chosen =
    source.length > 0
      ? source
      : localEnv !== undefined && (process.env[localEnv] ?? "").length > 0
        ? "local"
        : npm !== undefined
          ? "npm"
          : "cargo";

  const print = (path: string): void => {
    console.log(resolve(path));
  };

  if (chosen === "local") {
    const envPath = localEnv !== undefined ? process.env[localEnv] : undefined;
    if (envPath === undefined || envPath.length === 0) {
      console.error(`实现 ${name} 的本地二进制需要环境变量 ${localEnv ?? "<未登记>"} 指向可执行文件`);
      process.exit(1);
    }
    print(envPath);
    return;
  }

  if (chosen === "cargo") {
    if (cargo === undefined) {
      console.error(`实现 ${name} 未登记 cargo 获取方式`);
      process.exit(1);
    }
    const bin = join(REPO_ROOT, cargo.repo, cargo.bin);
    if (!existsSync(bin)) {
      console.error(`cargo 产物不存在：${bin}`);
      console.error(`先在 ${cargo.repo} 里构建：${cargo.command}`);
      process.exit(1);
    }
    print(bin);
    return;
  }

  if (chosen === "npm") {
    if (npm === undefined) {
      console.error(`实现 ${name} 未登记 npm 获取方式`);
      process.exit(1);
    }
    const destAbs = resolve(dest);
    mkdirSync(destAbs, { recursive: true });
    const manifest = join(destAbs, "package.json");
    if (!existsSync(manifest)) {
      writeFileSync(manifest, `${JSON.stringify({ name: "tsc-compa-tools", private: true }, null, 2)}\n`);
    }
    const spec = `${npm.package}@${npm.version}`;
    const r = spawnSync("bun", ["add", spec, "--cwd", destAbs], { encoding: "utf8", stdio: "inherit" });
    if (r.status !== 0) {
      console.error(`bun add ${spec} 失败（exit ${r.status}）`);
      process.exit(1);
    }
    const bin = join(destAbs, npm.bin);
    if (!existsSync(bin)) {
      console.error(`npm 包装好了，但二进制路径不存在：${bin}`);
      process.exit(1);
    }
    print(bin);
    return;
  }

  console.error(`--source 只接受 npm / local / cargo，收到 ${chosen}`);
  process.exit(2);
}

main();
