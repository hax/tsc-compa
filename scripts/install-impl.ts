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
  /** 本地开发用：仓库路径（相对 REPO_ROOT）；CI 缺省不存在时用 git 拉取。 */
  git?: { url: string; ref: string };
  command: string;
  /** 额外构建环境变量（例如 tsz 需要 CI=1）。 */
  env?: Record<string, string>;
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

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function run(cmd: string, args: string[], cwd: string, env?: Record<string, string | undefined>): void {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: "inherit", env: env ?? process.env });
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} 失败（exit ${r.status ?? "signal"}）`);
}

/**
 * 取得 cargo 获取方式的可执行文件：本地检出有产物直接用；否则在外部 target 目录构建。
 * 本地检出不存在时，按 implementations.json 的 git pin 浅拉取到 dest 下再构建（CI 路径）。
 * 源码与构建产物都落在 dest 下，不写入仓库检出。
 */
function ensureCargoBinary(name: string, cargo: CargoAcquisition, destAbs: string): string {
  const binRel = cargo.bin.replace(/^target\//, "");
  const targetDir = join(destAbs, "target", name);
  const binPath = join(targetDir, binRel);
  if (existsSync(binPath)) return binPath;

  const localRepo = join(REPO_ROOT, cargo.repo);
  let sourceDir: string;
  if (existsSync(join(localRepo, "Cargo.toml"))) {
    sourceDir = localRepo;
  } else if (cargo.git !== undefined) {
    const ref = cargo.git.ref;
    sourceDir = join(destAbs, "src", `${name}-${ref.slice(0, 7)}`);
    if (!existsSync(join(sourceDir, "Cargo.toml"))) {
      mkdirSync(sourceDir, { recursive: true });
      console.error(`拉取 ${cargo.git.url}@${ref} → ${sourceDir}`);
      run("git", ["init", "-q", sourceDir], destAbs);
      run("git", ["-C", sourceDir, "remote", "add", "origin", cargo.git.url], destAbs);
      run("git", ["-C", sourceDir, "fetch", "--depth", "1", "origin", ref], destAbs);
      run("git", ["-C", sourceDir, "checkout", "-q", "FETCH_HEAD"], destAbs);
    }
  } else {
    die(`实现 ${name} 的 cargo 产物不存在（${join(localRepo, cargo.bin)}），且未登记 git 获取方式`);
  }

  console.error(`构建 ${name}：${cargo.command}（CARGO_TARGET_DIR=${targetDir}）`);
  run("sh", ["-c", cargo.command], sourceDir, {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    ...(cargo.env ?? {}),
  });
  if (!existsSync(binPath)) die(`构建完成但产物不存在：${binPath}`);
  return binPath;
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
    print(ensureCargoBinary(name, cargo, resolve(dest)));
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
