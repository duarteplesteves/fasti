export const propConfig = {
  numRuns: process.env["CI"] ? 10_000 : 1000,
  seed: process.env["CI"] ? 42 : Date.now(),
} as const;
