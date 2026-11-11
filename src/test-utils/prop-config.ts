export const propConfig = {
  numRuns: 1000,
  seed: process.env["CI"] ? 42 : Date.now(),
} as const;
