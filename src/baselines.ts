// 多基线配置：把「tsc 版本 × 语料 tag」成对定义在 config/baselines.json。
//
// 两条轴是独立的：tsc 版本决定期望由谁生成（也决定 CLI 参数能力，例如
// 5.9 不认 --ignoreConfig）；语料 tag 决定用例集与用例内的指令集合。
// 一个 baseline = (tsc, baseArgs, corpus, manifest) 的一个具名组合。
//
// tsc 路径相对仓库根，指向 npm alias 安装的版本（node_modules/typescript-*），
// 这样同一工作区里可以并存多个 tsc，互不覆盖。

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CorpusRef {
  repo: string;
  ref: string;
  note?: string;
}

export interface BaselineDef {
  id: string;
  /** 相对仓库根的 tsc 可执行文件路径。 */
  tsc: string;
  /** 期望生成与适配器共用的基础 CLI 参数（不含用例选项与文件）。 */
  baseArgs: string[];
  /** corpora 里的 key。 */
  corpus: string;
  /** 该基线默认定作用例集（相对仓库根）。 */
  manifest: string;
  note?: string;
}

export interface BaselineConfig {
  corpora: Record<string, CorpusRef>;
  baselines: BaselineDef[];
  equivalentDiagnosticCodesByTscVersion?: Record<string, number[][]>;
}

export const REPO_ROOT = resolve(import.meta.dir, "..");

export const DEFAULT_CONFIG_PATH = join(REPO_ROOT, "config", "baselines.json");

export function loadBaselines(path: string = DEFAULT_CONFIG_PATH): BaselineConfig {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as BaselineConfig;
  if (typeof parsed.corpora !== "object" || !Array.isArray(parsed.baselines)) {
    throw new Error(`基线配置格式不对：${path}`);
  }
  return parsed;
}

export function findBaseline(config: BaselineConfig, id: string): BaselineDef {
  const found = config.baselines.find((b) => b.id === id);
  if (found === undefined) {
    throw new Error(`未知基线 ${id}；可用：${config.baselines.map((b) => b.id).join(" / ")}`);
  }
  return found;
}

/** tsc 路径：绝对路径原样返回，相对路径按仓库根解析。 */
export function resolveBaselineTsc(def: BaselineDef): string {
  return def.tsc.startsWith("/") ? def.tsc : join(REPO_ROOT, def.tsc);
}

/** 语料来源的可读标识（repo@ref），进 metrics.meta。 */
export function corpusRefOf(config: BaselineConfig, def: BaselineDef): string {
  const corpus = config.corpora[def.corpus];
  if (corpus === undefined) throw new Error(`基线 ${def.id} 引用了不存在的语料 ${def.corpus}`);
  return `${corpus.repo}@${corpus.ref}`;
}
