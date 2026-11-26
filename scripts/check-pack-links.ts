// Fails when a Markdown file in the npm package links to a path the package doesn't ship,
// so docs read from node_modules (by people or agents) never dead-end.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

const PackOutput = Schema.Tuple([
  Schema.Struct({
    files: Schema.Array(Schema.Struct({ path: Schema.String })),
  }),
]);

const [pack] = Schema.decodeUnknownSync(PackOutput)(
  JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      encoding: "utf-8",
    })
  )
);

const files = new Set(pack.files.map((f) => f.path));

const dirs = new Set(
  [...files].flatMap((f) =>
    f
      .split("/")
      .slice(0, -1)
      .map((_, i, parts) => parts.slice(0, i + 1).join("/"))
  )
);

const markdown = [...files].filter((f) => f.endsWith(".md"));
const broken: string[] = [];

for (const file of markdown) {
  const text = readFileSync(file, "utf-8").replaceAll(/```[\s\S]*?```/gu, "");

  // shortcut: checks paths only, not #anchors; add heading checks if anchors start breaking.
  for (const { groups } of text.matchAll(/\]\((?<target>[^)\s#]+)[^)]*\)/gu)) {
    const target = groups?.target ?? "";
    // https:, mailto:
    const external = /^[a-z]+:/iu.test(target);

    const resolved = path
      .normalize(path.join(path.dirname(file), target))
      .replace(/\/$/u, "");

    if (!external && !files.has(resolved) && !dirs.has(resolved)) {
      broken.push(`${file} → ${target}`);
    }
  }
}

if (broken.length > 0) {
  console.error(
    `Links to files the package doesn't ship:\n${broken.join("\n")}`
  );
  process.exit(1);
}

console.log(`Links OK in ${markdown.length} Markdown files.`);
