// The data branch is an input, never a publish root. Use the same strict
// validation as the public writer, then stage only the indexed resources.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicCatalog, readIndex, verifyPublic } from "./public-evaluation.ts";

export function stagePublicReports(data: string, output: string) {
  verifyPublic(data);
  const index = readIndex(data);
  const writeJson = (name: string, value: unknown) => writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`);
  const read = (name: string) => readFileSync(join(data, "reports", name), "utf8");
  mkdirSync(output);
  // Emit JSON from the parsed values so unvalidated bytes (e.g. shadowed
  // duplicate keys) cannot ride along in an otherwise valid resource.
  writeJson("catalog.json", publicCatalog());
  writeJson("index.json", index);
  for (const { id } of index.reports) {
    writeJson(`${id}.json`, JSON.parse(read(`${id}.json`)));
    // verifyPublic already matched this exact UTF-8 text against reportHtml.
    writeFileSync(join(output, `${id}.html`), read(`${id}.html`));
  }
}

if (import.meta.main) {
  const [data, output] = process.argv.slice(2);
  if (!data || !output || process.argv.length !== 4) throw new Error("Expected stage-public-reports <data-checkout> <output-reports>");
  stagePublicReports(data, output);
}
