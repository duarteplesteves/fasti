import { Effect } from "effect";
import { describe, expectTypeOf, it } from "vitest";

import type { Result } from "../core/result.js";
import type { Vetoed } from "./errors.js";
import type { WithAlso, WriteAction } from "./forms.js";

interface Params {
  readonly n: number;
}

interface Ctx {
  readonly tx: string;
}

interface Value {
  readonly v: 1;
}

declare const plain: WriteAction<"plain", Params, Ctx, Value, "E">;
declare const effect: WriteAction<"effect", Params, Ctx, void, "E">;

/** Never called: only the overload each call resolves to is checked. */
function calls() {
  return {
    effectAlso: effect({ also: () => Effect.fail("no" as const), n: 1 }),
    plain: plain({ n: 1 }),
    plainAlso: plain({
      also: (ctx) =>
        ctx.tx === ""
          ? { error: "empty" as const, ok: false as const }
          : { ok: true as const, value: ctx.tx.length },
      n: 1,
    }),
  };
}

type Calls = ReturnType<typeof calls>;

type PlainAlso = Awaited<Calls["plainAlso"]>;

describe("form types", () => {
  it("resolves the `also` overload first, inferring its value and veto, and falls back to the plain one", () => {
    expectTypeOf<Calls["plain"]>().toEqualTypeOf<Promise<Result<Value, "E">>>();
    expectTypeOf<Extract<PlainAlso, { ok: true }>["value"]>().toExtend<
      Value & { readonly also: number }
    >();
    expectTypeOf<
      Extract<PlainAlso, { ok: true }>["value"]["also"]
    >().toEqualTypeOf<number>();
    expectTypeOf<Extract<PlainAlso, { ok: false }>["error"]>().toEqualTypeOf<
      "E" | Vetoed<"empty">
    >();
    expectTypeOf<Calls["effectAlso"]>().toEqualTypeOf<
      Effect.Effect<{ readonly also: never }, "E" | Vetoed<"no">>
    >();
  });

  it("merges `also` into objects, wraps void, and leaves a repeat cancel alone", () => {
    expectTypeOf<WithAlso<void, 1>>().toEqualTypeOf<{ readonly also: 1 }>();
    expectTypeOf<
      WithAlso<{ readonly alreadyCancelled: true }, 1>
    >().toEqualTypeOf<{
      readonly alreadyCancelled: true;
    }>();
  });
});
