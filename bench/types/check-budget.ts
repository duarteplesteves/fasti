// The type-check budget (#175): type-check the Plugin fixture and fail on any error (including "Type instantiation is
// excessively deep") or when its instantiations exceed the budget. The baseline is printed alongside, for context.
import { spawnSync } from "node:child_process";

/** `baseline.fixture.ts` on v0.6.0, measured with tsgo 7.1.0-beta. */
const BASELINE_0_6 = 94_520;

/** 125% of the 0.6 baseline: three Plugins measured 110,799 (117%) when the budget was set. */
const BUDGET = Math.round(BASELINE_0_6 * 1.25);

/** Type-check one fixture's project; its instantiation count, or a failure message. */
function measure(
  project: string
):
  | { readonly ok: true; readonly count: number }
  | { readonly ok: false; readonly why: string } {
  const run = spawnSync(
    "node_modules/.bin/tsc",
    ["-p", `bench/types/${project}`, "--extendedDiagnostics"],
    { encoding: "utf-8" }
  );

  const output = `${run.stdout}${run.stderr}`;

  const count = /^Instantiations:\s+(?<count>\d+)$/mu.exec(output)?.groups
    ?.count;

  if (run.status !== 0 || count === undefined) {
    return { ok: false, why: `${project} doesn't type-check:\n${output}` };
  }

  return { count: Number(count), ok: true };
}

const baseline = measure("tsconfig.baseline.json");
const plugins = measure("tsconfig.plugins.json");

for (const result of [baseline, plugins]) {
  if (!result.ok) {
    console.error(result.why);
    process.exit(1);
  }
}

if (baseline.ok && plugins.ok) {
  console.log(
    `Instantiations: baseline ${baseline.count}, with Plugins ${plugins.count}; budget ${BUDGET} (0.6 baseline ${BASELINE_0_6}).`
  );

  if (plugins.count > BUDGET) {
    console.error(
      `Over the type-check budget by ${plugins.count - BUDGET} instantiations.`
    );
    process.exit(1);
  }
}
