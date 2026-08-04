#!/usr/bin/env node
/**
 * Inline the UI into a single self-contained page.
 *
 * One source of truth: the shareable prototype and the thing the server
 * actually serves are the same HTML, CSS and JS. A separate "design mockup"
 * would drift from the product within a week, and then be worse than nothing.
 *
 *   node scripts/build-artifact.mjs [outfile] [--standalone]
 *
 * By default it emits a body fragment (title + style + markup + script), which
 * is the shape the Artifact publisher wraps in its own document skeleton.
 * --standalone emits a complete HTML file you can open from disk.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (p) => readFileSync(resolve(root, p), "utf8");

const html = read("ui/index.html");
const css = read("ui/app.css");
const js = read("ui/app.js");

const body = html.match(/<body>([\s\S]*?)<\/body>/);
if (!body) throw new Error("ui/index.html has no <body>");

const markup = body[1].replace(/\s*<script src="\/app\.js"><\/script>/, "").trim();
const title = (html.match(/<title>([\s\S]*?)<\/title>/) ?? [, "LocalHarness"])[1];

const args = process.argv.slice(2);
const standalone = args.includes("--standalone");
const out = resolve(root, args.find((a) => !a.startsWith("--")) ?? "dist/artifact.html");

const head = [`<title>${title}</title>`, "<style>", css, "</style>"];
const tail = ["<script>", js, "</script>"];

const contents = standalone
  ? [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      ...head,
      "</head>",
      "<body>",
      markup,
      ...tail,
      "</body>",
      "</html>",
      "",
    ].join("\n")
  : [...head, "", markup, "", ...tail, ""].join("\n");

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, contents, "utf8");

const kb = (Buffer.byteLength(contents) / 1024).toFixed(1);
process.stdout.write(`${out}  ${kb} kB  ${standalone ? "(standalone)" : "(fragment)"}\n`);
