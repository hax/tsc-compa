// Append-only evidence policies. Never edit a published generation in place:
// the persisted catalog and compact reports must still validate before Pages
// can stage them. Runtime pins and args must match an active policy as well as
// the implementation registry; the policy alone cannot acquire a checker.
export const addedCandidates = ["ts-rust", "tsc-rs", "tsz"] as const;
export type AddedCandidate = typeof addedCandidates[number];
export const isAddedCandidate = (id: string): id is AddedCandidate => addedCandidates.some((candidate) => candidate === id);
export const rustToolchain = "1.99.1-x86_64-unknown-linux-gnu";

type CatalogueCandidate = { id: AddedCandidate; name: string; version: string };
type NpmSource = { kind: "npm"; package: string; version: string; sourceCommit: string; platformPackage: string; launcherSha256: string; platformSha256: string };
type CargoPin = { kind: "cargo"; repository: string; commit: string; lockSha256: string; rustc: string };
type CargoSource = CargoPin & { cargo: string; linker: string; buildImage: string };
export type PreparedSource = NpmSource | CargoSource;
export type PreparedEvidence = { source: PreparedSource; runtimeLibrariesSha256: string; environment: Record<string, string> };
type Policy = {
  candidate: CatalogueCandidate; cliArgs: readonly string[]; environment: Readonly<Record<string, string>>;
  selfReport: string;
} & ({ source: NpmSource; npmIntegrity: { launcher: string; platform: string }; nativeSha256: string } | { source: CargoPin });

type Generation = { policies: Record<AddedCandidate, Policy> };
const rustc = "rustc 1.99.1 (58cf8f9c3 2026-10-13)";
export const policyGenerations: readonly Generation[] = [
  { policies: {
    "ts-rust": {
      candidate: { id: "ts-rust", name: "ts-rust (pingdotgg)", version: "0.8.0" },
      cliArgs: ["--singleThreaded"], environment: {}, selfReport: "Version 7.1.0-dev",
      nativeSha256: "c2d321fe13ff304e40a7650ec123b96239ba1c568f3aa89cba04dfc6ac7c9f7d",
      source: { kind: "npm", package: "tsc-rs", version: "0.8.0", platformPackage: "@tsc-rs/linux-x64", sourceCommit: "4c032be6dbef6dafaae2358ece165d138f8e0da8",
        launcherSha256: "22c0e3f19f98eac88085d2edf5b0ece99c76481c274f29964c14be2fe335e697",
        platformSha256: "05a13e235b6d6561a73bb57d412c854ea33bde888aacddcd8336245253a1be47" },
      npmIntegrity: {
        launcher: "sha512-W8S1FKujMD7PDEWFdC/SmoT8uUgY7VEdUi0rcSbUNux5beVSVMFm0EaW4BkFJklZFgFEbDyNALcQpUEldDCvLQ==",
        platform: "sha512-c1DPPfJ6F8HkScESepl42p4Cph8BcKcd3dBakYLBPyWiKZD8q3bw/kDNoAQoTnO3k8Zkv5FFbI85ot4y6gNQuA==",
      },
    },
    "tsc-rs": {
      candidate: { id: "tsc-rs", name: "tsc-rs (kazhiramatsu)", version: "2b006e0" },
      cliArgs: ["--checkers", "1"], environment: {}, selfReport: "Version 7.1.0-dev",
      source: { kind: "cargo", repository: "kazhiramatsu/tsc-rs", commit: "2b006e078d5b535185f5aeea04406eab7b8aee3c",
        lockSha256: "6e75654c5a4bef972e5ab10aff7cb2e65a6935a105817c357815a67b297c0be3", rustc },
    },
    tsz: {
      candidate: { id: "tsz", name: "tsz", version: "0b4641a" },
      cliArgs: [], environment: { TSZ_USE_EMBEDDED_LIBS: "1" }, selfReport: "Version 7.0.2",
      source: { kind: "cargo", repository: "tsz-org/tsz", commit: "0b4641ac285f5991a3e805e395e7e4f9ef71f90e",
        lockSha256: "bd7e1194e3ff757bea063f8b7198966af8337a4f22ccf80d110992d657a8349f", rustc },
    },
  } },
];
export const activePolicies = policyGenerations.at(-1)!.policies;
const validString = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
const isObject = (v: unknown, keys: string) => typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.keys(v).sort().join(" ") === keys.split(" ").sort().join(" ");

function matches(policy: Policy, prepared: PreparedEvidence, cliArgs: readonly string[], tool: { version: string; sha256: string; nativeSha256: string | null; embeddedTypeScript: string | null }) {
  if (!isObject(prepared, "source runtimeLibrariesSha256 environment") || !validString(prepared.runtimeLibrariesSha256, /^[a-f0-9]{64}$/) ||
      JSON.stringify(prepared.environment) !== JSON.stringify(policy.environment) || JSON.stringify(cliArgs) !== JSON.stringify(policy.cliArgs) ||
      tool.version !== policy.selfReport || tool.nativeSha256 !== null || tool.embeddedTypeScript !== null) return false;
  const source = prepared.source;
  const pin = policy.source;
  if (pin.kind === "npm") return "nativeSha256" in policy && tool.sha256 === policy.nativeSha256 &&
    isObject(source, Object.keys(pin).join(" ")) && Object.entries(pin).every(([key, expected]) => source[key as keyof typeof source] === expected);
  return isObject(source, "kind repository commit lockSha256 rustc cargo linker buildImage") && source.kind === "cargo" &&
    source.repository === pin.repository && source.commit === pin.commit && source.lockSha256 === pin.lockSha256 && source.rustc === pin.rustc &&
    validString(source.cargo, /^cargo 1\.99\.1 \([a-f0-9]+ \d{4}-\d\d-\d\d\)$/) && validString(source.linker, /^\d+(?:\.\d+){1,2}$/) &&
    validString(source.buildImage, /^\d[\w.-]{1,63}$/);
}

export function validPrepared(id: AddedCandidate, version: string, prepared: PreparedEvidence, cliArgs: readonly string[], tool: Parameters<typeof matches>[3], historical = false) {
  const policies = historical ? policyGenerations.map((generation) => generation.policies[id]) : [activePolicies[id]];
  return policies.some((policy) => version === policy.candidate.version && matches(policy, prepared, cliArgs, tool));
}
