import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import * as adapter from "./adapter/index.js";
import * as core from "./core/index.js";
import * as drizzlePg from "./drizzle/pg/index.js";
import * as effect from "./effect/index.js";
import * as root from "./index.js";
import * as memory from "./memory/index.js";
import * as testing from "./testing/index.js";

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly exports: Readonly<
    Record<
      string,
      string | { readonly types: string; readonly default: string }
    >
  >;
}

// SAFETY: our own package.json, shaped as above.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
) as PackageJson;

interface Entry {
  /** The source entry, relative to `src/`, as its built `.js` path. */
  readonly source: string;
  readonly module: object;
  /** Runtime names only, sorted; types are covered by `tsc` and attw. */
  readonly names: readonly string[];
}

const surface = [
  {
    module: root,
    names: ["AdapterError", "column", "createScheduler", "defineSchema"],
    source: "index.js",
  },
  { module: adapter, names: ["defineAdapter"], source: "adapter/index.js" },
  {
    module: core,
    names: [
      "checkRule",
      "detectConflicts",
      "expandRules",
      "findFreeSlots",
      "isSlotValid",
      "withBlockingFlag",
    ],
    source: "core/index.js",
  },
  {
    module: drizzlePg,
    names: [
      "availabilityRuleTable",
      "backstopSql",
      "blockTable",
      "bookingTable",
      "drizzleAdapter",
    ],
    source: "drizzle/pg/index.js",
  },
  { module: effect, names: ["Scheduler"], source: "effect/index.js" },
  { module: memory, names: ["memoryAdapter"], source: "memory/index.js" },
  {
    module: testing,
    names: ["conformanceCases", "runCase", "testAdapter"],
    source: "testing/index.js",
  },
] as const satisfies readonly Entry[];

function subpath(source: string): string {
  const dir = source.replace(/\/?index\.js$/u, "");

  return dir === "" ? "." : `./${dir}`;
}

describe("package export surface", () => {
  it("maps exactly these subpaths", () => {
    expect(Object.keys(pkg.exports).toSorted()).toStrictEqual(
      [...surface.map((e) => subpath(e.source)), "./package.json"].toSorted()
    );
  });

  it.each(surface)(
    "$source: its subpath resolves to it, and it exports exactly its names",
    (e) => {
      expect(pkg.exports[subpath(e.source)]).toStrictEqual({
        default: `./dist/${e.source}`,
        types: `./dist/${e.source.replace(/\.js$/u, ".d.ts")}`,
      });
      expect(Object.keys(e.module).toSorted()).toStrictEqual(e.names);
    }
  );

  it("effect/index.js exports the type TxOf", () => {
    expectTypeOf<effect.TxOf<adapter.Adapter<"tx">>>().toEqualTypeOf<"tx">();
  });

  it("the package's only runtime dependency is effect (ADR 012)", () => {
    expect(pkg.dependencies).toStrictEqual({ effect: "^4.1" });
  });

  it("the Core imports nothing outside itself", () => {
    const coreDir = new URL("core/", import.meta.url);

    const sources = readdirSync(coreDir).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts")
    );

    const outside = sources.flatMap((f) =>
      [
        ...readFileSync(new URL(f, coreDir), "utf-8").matchAll(
          /\bfrom\s+["'](?<specifier>[^"']+)["']/gu
        ),
      ].flatMap((m) => {
        const specifier = m.groups?.["specifier"] ?? "";

        return specifier.startsWith("./") ? [] : [specifier];
      })
    );

    expect(sources).not.toHaveLength(0);
    expect(outside).toStrictEqual([]);
  });
});
