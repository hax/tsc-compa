// Diagnostic evidence and permission to use it as a gate are separate. The
// checker-batch peer can describe what it supports; it cannot grant authority.
import type { Adapter, OptionNegotiation } from "./types.ts";

export type VerdictBasis =
  | "fixed-mode"
  | "static-options"
  | "static-no-options"
  | "legacy-batch"
  | "negotiation-pending"
  | "negotiation-failed"
  | "negotiated-no-option-support"
  | "negotiated-no-comparisons"
  | "negotiated-mixed-comparisons"
  | "candidate-option-overrides"
  | "negotiated-compared-subset";

interface VerdictPolicy {
  basis: VerdictBasis;
  comparedSubsetEligible: boolean;
  gateAuthorized: boolean;
  ratchetWriteAuthorized: boolean;
}

interface ComparisonEvidence {
  compared: number;
  negotiatedComparisons: number;
  candidateOverrideComparisons: number;
}

export interface OptionAssessment extends VerdictPolicy, Omit<ComparisonEvidence, "compared">,
  Pick<Adapter, "supportsOptions" | "capabilities" | "batchImplementation"> {
  negotiation: OptionNegotiation;
}

export function finalizeOptionAssessment(
  mode: "official" | "fixed",
  adapter: Adapter,
  evidence: ComparisonEvidence,
): { policy: VerdictPolicy; assessment?: OptionAssessment } {
  const { supportsOptions, optionNegotiation: negotiation } = adapter;
  const { compared, negotiatedComparisons, candidateOverrideComparisons } = evidence;
  const untrusted = (basis: VerdictBasis, comparedSubsetEligible = false): VerdictPolicy => ({
    basis, comparedSubsetEligible, gateAuthorized: false, ratchetWriteAuthorized: false,
  });
  let policy: VerdictPolicy;
  if (mode === "fixed") policy = untrusted("fixed-mode");
  else if (negotiation !== undefined) {
    switch (negotiation) {
      case "legacy": policy = untrusted("legacy-batch"); break;
      case "pending": policy = untrusted("negotiation-pending"); break;
      case "failed": policy = untrusted("negotiation-failed"); break;
      case "negotiated":
        policy = !supportsOptions ? untrusted("negotiated-no-option-support")
          : compared === 0 ? untrusted("negotiated-no-comparisons")
          : negotiatedComparisons !== compared ? untrusted("negotiated-mixed-comparisons")
          : candidateOverrideComparisons > 0 ? untrusted("candidate-option-overrides")
          : untrusted("negotiated-compared-subset", true);
        break;
    }
  } else policy = supportsOptions
    ? { basis: "static-options", comparedSubsetEligible: true, gateAuthorized: true, ratchetWriteAuthorized: true }
    : untrusted("static-no-options");

  if (negotiation === undefined) return { policy };
  const { capabilities, batchImplementation } = adapter;
  // Copy adapter-owned objects: later probes/teardown cannot rewrite this run.
  return { policy, assessment: {
    ...policy, negotiation, supportsOptions, negotiatedComparisons, candidateOverrideComparisons,
    ...(capabilities === undefined ? {} : { capabilities: structuredClone(capabilities) }),
    ...(batchImplementation === undefined ? {} : { batchImplementation: structuredClone(batchImplementation) }),
  } };
}

export const VERDICT_BASIS_TEXT: Record<VerdictBasis, string> = {
  "fixed-mode": "fixed 模式只验证调用流水线",
  "static-options": "适配器静态支持外部选项",
  "static-no-options": "适配器不接受外部选项",
  "legacy-batch": "旧批量协议未协商选项支持",
  "negotiation-pending": "运行结束时仍未完成选项协商",
  "negotiation-failed": "选项协商失败",
  "negotiated-no-option-support": "协商已完成，但适配器未声明支持外部选项",
  "negotiated-no-comparisons": "已协商，但没有完成诊断比较",
  "negotiated-mixed-comparisons": "并非所有已比较配置都在协商后完成",
  "candidate-option-overrides": "存在仅传给候选的覆盖项，且已比较配置的两侧参数不同；仅供对照实验",
  "negotiated-compared-subset": "仅可解读已比较配置的诊断结果；选项支持由候选自报",
};

export function verdictBasisText(basis: VerdictBasis): string {
  return VERDICT_BASIS_TEXT[basis];
}
