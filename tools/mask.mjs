#!/usr/bin/env node
// Paints white bars over number plates in photos/, driven by content/masks.json.
//
//   node tools/mask.mjs --preview   zoomed crops around every box, to check aim
//   node tools/mask.mjs --apply     writes the bars into photos/ in place
//
// Why this is destructive rather than a build step: photos/ is committed to a
// PUBLIC repository. Masking at build time would publish the unmasked original
// in git and defeat the entire point.
//
// Every run reads from .originals/ — an untouched copy made the first time a
// file is seen, and gitignored. So a box can be corrected and re-applied
// without stacking bars, and a bad box can never destroy the only copy.
//
// Coordinates in masks.json are FRACTIONS of width and height, not pixels.
// A replacement photo at a different resolution keeps the same numbers.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (...p) => path.join(ROOT, ...p);

const APPLY = process.argv.includes("--apply");
const CHECK = process.argv.includes("--check");
const PREVIEW = process.argv.includes("--preview") || (!APPLY && !CHECK);

// Font for the grid labels in --check. ImageMagick has no default font on
// NixOS, so one has to be named explicitly.
const GRID_FONT = process.env.GRID_FONT ?? "";

const masks = JSON.parse(fs.readFileSync(P("content", "masks.json"), "utf8"));
const origDir = P(".originals");
const previewDir = P(".cache", "mask-preview");

fs.mkdirSync(origDir, { recursive: true });
if (PREVIEW || CHECK) fs.mkdirSync(previewDir, { recursive: true });

const sh = (args) => execFileSync("magick", args, { encoding: "utf8" }).trim();

let applied = 0;
let boxCount = 0;

for (const [file, spec] of Object.entries(masks)) {
  if (file.startsWith("_")) continue;
  const boxes = spec.boxes ?? [];
  if (!boxes.length) continue;

  const live = P("photos", file);
  if (!fs.existsSync(live)) {
    console.log(`! ${file} listed in masks.json but not in photos/ — skipped`);
    continue;
  }

  // First sighting: stash the untouched file. Never overwritten afterwards,
  // so this stays the pre-mask original across any number of re-runs.
  const orig = path.join(origDir, file);
  if (!fs.existsSync(orig)) fs.copyFileSync(live, orig);

  const [w, h] = sh(["identify", "-format", "%w %h", orig]).split(" ").map(Number);

  const rects = boxes.map(([bx, by, bw, bh]) => {
    const x1 = Math.round(bx * w);
    const y1 = Math.round(by * h);
    const x2 = Math.round((bx + bw) * w);
    const y2 = Math.round((by + bh) * h);
    return { x1, y1, x2, y2 };
  });

  boxCount += rects.length;

  const drawArgs = rects.flatMap((r) => ["-draw", `rectangle ${r.x1},${r.y1} ${r.x2},${r.y2}`]);

  if (APPLY) {
    // -quality 92: the file is re-encoded, so it must not be re-compressed at
    // the pipeline's delivery quality. This is still a SOURCE image; the build
    // generates the delivery sizes from it afterwards.
    execFileSync("magick", [orig, "-fill", "white", "-stroke", "none", ...drawArgs, "-quality", "92", live]);
    applied++;
    console.log(`✓ ${file}  ${rects.length} bar(s)`);
  }

  if (CHECK) {
    // Whole frame, 5% grid labelled in ABSOLUTE fractions, current box in red.
    // Self-locating: the plate and the box are both in view against the same
    // scale, so a wrong box is corrected by reading, not by guessing.
    const TW = w >= h ? 1150 : Math.round((w / h) * 1150);
    const TH = w >= h ? Math.round((h / w) * 1150) : 1150;
    const lines = [];
    const labels = [];
    for (let i = 1; i < 20; i++) {
      const gx = Math.round((TW * i) / 20);
      const gy = Math.round((TH * i) / 20);
      lines.push(`line ${gx},0 ${gx},${TH}`, `line 0,${gy} ${TW},${gy}`);
      if (i % 2 === 0) labels.push(`text ${gx + 3},16 '${(i / 20).toFixed(2).slice(1)}'`,
                                   `text 3,${gy - 4} '${(i / 20).toFixed(2).slice(1)}'`);
    }
    const red = rects.map((r) => {
      const s = TW / w;
      const t = TH / h;
      return `rectangle ${Math.round(r.x1 * s)},${Math.round(r.y1 * t)} ${Math.round(r.x2 * s)},${Math.round(r.y2 * t)}`;
    });
    execFileSync("magick", [
      orig, "-resize", `${TW}x${TH}!`,
      "-stroke", "#00ff55", "-strokewidth", "1", "-fill", "none", "-draw", lines.join(" "),
      ...(GRID_FONT ? ["-font", GRID_FONT] : []),
      "-stroke", "none", "-fill", "#00ff55", "-pointsize", "17", "-draw", labels.join(" "),
      "-stroke", "#ff0033", "-strokewidth", "3", "-fill", "none", "-draw", red.join(" "),
      path.join(previewDir, `check-${file}`),
    ]);
  }

  if (PREVIEW) {
    // Crop generously around each box so it is obvious whether the bar covers
    // the plate completely or clips a corner.
    rects.forEach((r, i) => {
      const padX = Math.round((r.x2 - r.x1) * 0.9);
      const padY = Math.round((r.y2 - r.y1) * 1.6);
      const cx = Math.max(0, r.x1 - padX);
      const cy = Math.max(0, r.y1 - padY);
      const cw = Math.min(w - cx, r.x2 - r.x1 + padX * 2);
      const ch = Math.min(h - cy, r.y2 - r.y1 + padY * 2);
      const out = path.join(previewDir, `${file.replace(/\.[^.]+$/, "")}-${i}.jpg`);
      execFileSync("magick", [
        orig,
        "-fill", "white", "-stroke", "none", ...drawArgs,
        "-crop", `${cw}x${ch}+${cx}+${cy}`, "+repage",
        "-resize", "420x", "-quality", "88",
        out,
      ]);
    });
  }
}

if (APPLY) {
  console.log(`\n${applied} photo(s) masked, ${boxCount} bar(s). Originals kept in .originals/ (gitignored).`);
} else {
  console.log(`\n${boxCount} bar(s) previewed in .cache/mask-preview/ — nothing written to photos/.`);
  console.log(`Run with --apply once every bar covers its plate.`);
}
