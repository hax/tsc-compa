// 固定 npm 发布的 opt-in 候选：使用 tsrs 自己的 async SDK 和原生后端。
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import pilotPackage from "../../config/tsrs-async/package.json" with { type: "json" };
import { REPO_ROOT } from "../baselines.ts";
import { identifyTool, sha256 } from "../provenance.ts";
import { Ts7ApiAdapter } from "./ts7-api.ts";

const SDK_MODULE = "tsrs/async";
const VERSION = pilotPackage.dependencies.tsrs;
const INSTALL_DIR = "config/tsrs-async";

export async function createTsrsAsyncAdapter() {
  if (process.env.TSRS_BINARY) {
    throw new Error("tsrs-async 仅使用固定 npm 后端；请取消设置 TSRS_BINARY");
  }
  const sdkDir = join(REPO_ROOT, INSTALL_DIR);
  if (!existsSync(join(sdkDir, "bun.lock"))) {
    throw new Error(`tsrs-async 缺少固定锁文件 ${INSTALL_DIR}/bun.lock；请恢复仓库中的锁文件`);
  }
  let modulesDir: string;
  let packageFile: string;
  let modulePath: string;
  try {
    modulesDir = realpathSync(join(sdkDir, "node_modules"));
    packageFile = realpathSync(join(modulesDir, "tsrs", "package.json"));
    // 从已找到的 tsrs 包解析自己的 exports，不从运行器目录另找 SDK。
    modulePath = realpathSync(createRequire(packageFile).resolve(SDK_MODULE));
  } catch (error) {
    throw new Error(`缺少固定 tsrs SDK；请先运行 bun install --cwd ${INSTALL_DIR} --frozen-lockfile --registry=https://registry.npmjs.org`, { cause: error });
  }
  if (!packageFile.startsWith(modulesDir + sep) || !modulePath.startsWith(dirname(packageFile) + sep)) {
    throw new Error(`tsrs-async SDK 不在隔离安装目录 ${modulesDir} 中：${modulePath}`);
  }
  const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  if (pkg.name !== "tsrs" || pkg.version !== VERSION) {
    throw new Error(`tsrs-async 需要 tsrs@${VERSION}，实际为 ${pkg.name}@${pkg.version}`);
  }

  // 复用此版本 SDK 的平台选择逻辑（包括 Linux libc）。把同一个原生路径
  // 显式传给 SDK 并用于取指纹，不运行 npm CLI launcher，也不回退到官方 tsc。
  const { default: getExePath } = await import(join(dirname(packageFile), "lib", "getExePath.js")) as { default: () => string };
  const backendPath = realpathSync(getExePath());
  if (!backendPath.startsWith(modulesDir + sep)) {
    throw new Error(`tsrs-async 原生后端不在隔离安装目录 ${modulesDir} 中：${backendPath}`);
  }
  const backend = identifyTool(backendPath);
  if (!backend?.sha256 || !backend.version?.includes(`(tsrs ${VERSION},`)) {
    throw new Error(`tsrs-async 后端未自报固定 tsrs 版本 ${VERSION}：${backendPath}`);
  }
  const sdk = { module: SDK_MODULE, path: modulePath, version: VERSION, sha256: sha256(readFileSync(modulePath)) };
  return Object.assign(new Ts7ApiAdapter({ name: "tsrs-async", moduleName: modulePath, tsserverPath: backendPath }), {
    toolIdentity: { ...backend, sdk },
  });
}
