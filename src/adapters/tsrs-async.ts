// 固定 npm 发布的 opt-in 候选：使用 tsrs 自己的 async SDK 和原生后端。
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT } from "../baselines.ts";
import { identifyTool, sha256 } from "../provenance.ts";
import { Ts7ApiAdapter } from "./ts7-api.ts";

const SDK_MODULE = "tsrs/async";
const VERSION = "0.25.0-ts7.1.0-beta";
const INSTALL_DIR = ".cache/tsrs-async/sdk";

export async function createTsrsAsyncAdapter() {
  if (process.env.TSRS_BINARY) {
    throw new Error("tsrs-async 仅使用固定 npm 后端；请取消设置 TSRS_BINARY");
  }
  const sdkDir = join(REPO_ROOT, INSTALL_DIR);
  let packageFile: string;
  let modulePath: string;
  try {
    packageFile = realpathSync(join(sdkDir, "node_modules", "tsrs", "package.json"));
    modulePath = realpathSync(Bun.resolveSync(SDK_MODULE, sdkDir));
  } catch (error) {
    throw new Error(`缺少固定 tsrs SDK；请先运行 bun scripts/install-impl.ts --name tsrs --source npm --dest ${INSTALL_DIR}`, { cause: error });
  }
  const pkg = JSON.parse(readFileSync(packageFile, "utf8"));
  if (pkg.name !== "tsrs" || pkg.version !== VERSION) {
    throw new Error(`tsrs-async 需要 tsrs@${VERSION}，实际为 ${pkg.name}@${pkg.version}`);
  }

  // 复用此版本 SDK 的平台选择逻辑（包括 Linux libc）。把同一个原生路径
  // 显式传给 SDK 并用于取指纹，不运行 npm CLI launcher，也不回退到官方 tsc。
  const { default: getExePath } = await import(join(dirname(packageFile), "lib", "getExePath.js")) as { default: () => string };
  const backendPath = realpathSync(getExePath());
  const backend = identifyTool(backendPath);
  if (!backend?.sha256 || !backend.version?.includes(`(tsrs ${VERSION},`)) {
    throw new Error(`tsrs-async 后端未自报固定 tsrs 版本 ${VERSION}：${backendPath}`);
  }
  const sdk = { module: SDK_MODULE, path: modulePath, version: VERSION, sha256: sha256(readFileSync(modulePath)) };
  return Object.assign(new Ts7ApiAdapter({ name: "tsrs-async", moduleName: modulePath, tsserverPath: backendPath }), {
    toolIdentity: { ...backend, sdk },
  });
}
