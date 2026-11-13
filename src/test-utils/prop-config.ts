export const propConfig = {
  numRuns: 1000,
  seed: process.env["CI"] === undefined ? Date.now() : 42,
} as const;
