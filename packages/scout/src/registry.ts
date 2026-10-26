import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { parse as parseYaml } from "yaml";
import { ScoutError, type Intent, type RegistryData } from "./types.js";
export function readData(path: string): unknown {
  const text = readFileSync(path, "utf8");
  return /ya?ml$/i.test(extname(path)) ? parseYaml(text) : JSON.parse(text);
}
export class IntentRegistry {
  readonly version: number;
  readonly intents: Intent[];
  constructor(data: RegistryData) {
    this.version = data.registryVersion ?? data.version ?? 1;
    this.intents = structuredClone(data.intents);
    const seen = new Set<string>();
    for (const i of this.intents) {
      if (
        !i.id ||
        seen.has(i.id) ||
        !i.examples?.length ||
        !i.capabilities ||
        !i.roles?.length ||
        !i.surfaces?.length ||
        !Number.isInteger(i.version) ||
        i.version < 1
      )
        throw new ScoutError("Invalid or duplicate intent registration", "INVALID_REGISTRY");
      seen.add(i.id);
    }
    if (!seen.has("GENERAL")) throw new ScoutError("A safe GENERAL fallback is required", "INVALID_REGISTRY");
  }
  static fromFile(path: string) {
    return new IntentRegistry(readData(path) as RegistryData);
  }
  static fromDirectory(path: string) {
    const entries = readdirSync(path)
      .filter((f) => /\.(json|ya?ml)$/i.test(f))
      .sort()
      .flatMap((file) => {
        const data = readData(join(path, file)) as Intent | RegistryData;
        return "intents" in data ? data.intents : [data];
      });
    return new IntentRegistry({ version: Math.max(1, ...entries.map((i) => i.version)), intents: entries });
  }
  static compose(registries: IntentRegistry[]) {
    return new IntentRegistry({
      version: Math.max(1, ...registries.map((r) => r.version)),
      intents: registries.flatMap((r) => r.intents),
    });
  }
  static load(input: string | RegistryData | IntentRegistry) {
    return input instanceof IntentRegistry
      ? input
      : typeof input === "string"
        ? statSync(input).isDirectory()
          ? this.fromDirectory(input)
          : this.fromFile(input)
        : new IntentRegistry(input);
  }
}
