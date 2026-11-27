// Append-only evidence policies. Never edit a published generation in place:
// the persisted catalog and compact reports must still validate before Pages
// can stage them. Public release recipes deliberately do not replace the
// separate smoke registry pins.
export const addedCandidates = ["ts-rust", "tsc-rs", "tsz"] as const;
export type AddedCandidate = typeof addedCandidates[number];
export const isAddedCandidate = (id: string): id is AddedCandidate => addedCandidates.some((candidate) => candidate === id);
export const rustToolchain = "1.93.0-x86_64-unknown-linux-gnu";

type CatalogueCandidate = { id: AddedCandidate; name: string; version: string };
type NpmSource = { kind: "npm"; package: string; version: string; sourceCommit: string; platformPackage: string; launcherSha256: string; platformSha256: string };
type CargoPin = { kind: "cargo"; repository: string; tag: string; commit: string; lockSha256: string; rustc: string };
type ReleaseSource = { kind: "release"; repository: string; tag: string; commit: string; asset: string; archiveSha256: string; checksumsSha256: string };
type CargoSource = CargoPin & { cargo: string; linker: string; buildImage: string };
export type PreparedSource = NpmSource | CargoSource | ReleaseSource;
export type PreparedEvidence = { source: PreparedSource; runtimeLibrariesSha256: string; environment: Record<string, string> };
type Policy = {
  candidate: CatalogueCandidate; cliArgs: readonly string[]; environment: Readonly<Record<string, string>>;
  selfReport: string; invocation?: "project"; stackBytes?: number;
} & ({ source: NpmSource; npmIntegrity: { launcher: string; platform: string }; nativeSha256: string } | { source: CargoPin; cargoVersion: string } | { source: ReleaseSource });

type Generation = { policies: Record<AddedCandidate, Policy> };
const rustc = "rustc 1.93.0 (254b59607 2026-01-19)";
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
      candidate: { id: "tsc-rs", name: "tsc-rs (kazhiramatsu)", version: "v0.1.0" },
      cliArgs: [], environment: { TSRS_CHECKERS: "1" }, selfReport: "Version 6.0.3", invocation: "project", stackBytes: 32 * 1024 * 1024,
      cargoVersion: "cargo 1.93.0 (083ac5135 2025-12-15)",
      source: { kind: "cargo", repository: "kazhiramatsu/tsc-rs", tag: "v0.1.0", commit: "ed173ea362dcd2a6e3d34d508506573ce736d88b",
        lockSha256: "87c76d4e279d777cf6a4cbdae389462e77c0fa3b0089392e4f8746984b16528f", rustc },
    },
    tsz: {
      candidate: { id: "tsz", name: "tsz", version: "v0.1.75" },
      cliArgs: [], environment: { TSZ_USE_EMBEDDED_LIBS: "1" }, selfReport: "Version 7.0.2",
      source: { kind: "release", repository: "tsz-org/tsz", tag: "v0.1.75", commit: "0c0e53f96bfd64be253cdd8c53e2853fd5cfdadb",
        asset: "tsz-v0.1.75-x86_64-unknown-linux-gnu.tar.gz", archiveSha256: "2feb40f7a2371e397988d6250b3680bc903c88063c6384f72f902122d8d2f7e6",
        checksumsSha256: "faaae84be17efa9baa4742a1ff686348b34d7003441d0d1df5ee3267619e07c2" },
    },
  } },
];
export const activePolicies = policyGenerations.at(-1)!.policies;
const validString = (v: unknown, re: RegExp) => typeof v === "string" && re.test(v);
const isObject = (v: unknown, keys: string) => typeof v === "object" && v !== null && !Array.isArray(v) &&
  Object.keys(v).sort().join(" ") === keys.split(" ").sort().join(" ");

function matches(policy: Policy, prepared: PreparedEvidence, cliArgs: readonly string[], tool: { version: string; sha256: string; nativeSha256: string | null; embeddedTypeScript: string | null }, invocation: string | undefined, stackBytes: number | undefined) {
  if (!isObject(prepared, "source runtimeLibrariesSha256 environment") || !validString(prepared.runtimeLibrariesSha256, /^[a-f0-9]{64}$/) ||
      JSON.stringify(prepared.environment) !== JSON.stringify(policy.environment) || JSON.stringify(cliArgs) !== JSON.stringify(policy.cliArgs) ||
      invocation !== policy.invocation || stackBytes !== policy.stackBytes || tool.version !== policy.selfReport || tool.nativeSha256 !== null || tool.embeddedTypeScript !== null) return false;
  const source = prepared.source;
  const pin = policy.source;
  if (pin.kind === "npm") return "nativeSha256" in policy && tool.sha256 === policy.nativeSha256 &&
    isObject(source, Object.keys(pin).join(" ")) && Object.entries(pin).every(([key, expected]) => source[key as keyof typeof source] === expected);
  if (pin.kind === "release") return isObject(source, Object.keys(pin).join(" ")) &&
    Object.entries(pin).every(([key, expected]) => source[key as keyof typeof source] === expected);
  return isObject(source, "kind repository tag commit lockSha256 rustc cargo linker buildImage") && source.kind === "cargo" &&
    source.repository === pin.repository && source.tag === pin.tag && source.commit === pin.commit && source.lockSha256 === pin.lockSha256 && source.rustc === pin.rustc &&
    "cargoVersion" in policy && source.cargo === policy.cargoVersion && validString(source.linker, /^\d+(?:\.\d+){1,2}$/) &&
    validString(source.buildImage, /^\d[\w.-]{1,63}$/);
}

export function validPrepared(id: AddedCandidate, version: string, prepared: PreparedEvidence, cliArgs: readonly string[], tool: Parameters<typeof matches>[3], invocation?: string, stackBytes?: number, historical = false) {
  const policies = historical ? policyGenerations.map((generation) => generation.policies[id]) : [activePolicies[id]];
  return policies.some((policy) => version === policy.candidate.version && matches(policy, prepared, cliArgs, tool, invocation, stackBytes));
}
