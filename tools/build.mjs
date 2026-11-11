#!/usr/bin/env node
// Builds dist/ from content/*.json + photos/ + src/.
//
// Everything is static and dependency-free on purpose: this site exists to be
// scanned off a paper flyer by a stranger on Australian mobile data, so the
// deployed artefact is plain HTML with the CSS inlined, one small JS file, and
// images in three formats. No framework, no hydration, no runtime fetch.
//
// Usage:  node tools/build.mjs [--strict] [--serve]
//
//   --strict  fail on any unfilled (null) field in car.json. CI uses this, so
//             a placeholder can never reach the published site.
//   --serve   build, then serve dist/ on :8080 for a local look.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (...p) => path.join(ROOT, ...p);

const STRICT = process.argv.includes("--strict");
const SERVE = process.argv.includes("--serve");

// Widths the browser may pick from. Capped per-photo at the source width —
// upscaling would cost bytes and deliver nothing.
const WIDTHS = [400, 800, 1200, 1600];
const LQIP_WIDTH = 24;

const missing = [];
const warnings = [];

// ---------------------------------------------------------------- utilities

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Read a possibly-unfilled value. null => recorded as missing, rendered loud. */
function need(value, label) {
  if (value === null || value === undefined || value === "") {
    missing.push(label);
    return null;
  }
  return value;
}

/** Render a value, or a visible placeholder when it has not been filled in. */
function val(value, label, fmt = (v) => v) {
  const v = need(value, label);
  return v === null ? `<span class="todo" title="car.json: ${esc(label)}">missing</span>` : esc(fmt(v));
}

const nf = new Intl.NumberFormat("en-AU");
const money = (n) => "$" + nf.format(n);
const km = (n) => nf.format(n) + " km";

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
}

/** Run n promise-returning jobs with bounded concurrency. */
async function pool(items, limit, worker) {
  const queue = [...items.entries()];
  const results = new Array(items.length);
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [i, item] = next;
      results[i] = await worker(item, i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ------------------------------------------------------------ image pipeline

const CACHE_FILE = P(".cache", "images.json");
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};

function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
}

/**
 * Produce every derivative of one source photo and the metadata the template
 * needs. Cached on the source file's content hash, so re-running after a copy
 * edit is instant and swapping one photo only rebuilds that photo.
 */
async function processPhoto(src) {
  const slug = path.basename(src).replace(/\.[^.]+$/, "");
  const hash = hashFile(src);
  const outDir = P("dist", "img");

  const cached = cache[slug];
  if (cached?.hash === hash && cached.files.every((f) => fs.existsSync(path.join(outDir, f)))) {
    return cached.meta;
  }

  const [w, h] = sh("magick", ["identify", "-format", "%w %h", src + "[0]"]).split(" ").map(Number);
  const dominant = sh("magick", [src + "[0]", "-resize", "1x1!", "-format", "%[hex:p{0,0}]", "info:"]);

  const widths = WIDTHS.filter((x) => x <= w);
  if (widths.length === 0) widths.push(w);
  if (w < 1200) warnings.push(`${path.basename(src)} is only ${w}px wide — fine for the grid, soft in the lightbox`);

  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aty-"));
  const files = [];

  try {
    for (const width of widths) {
      // One high-quality intermediate per width, then three encoders read it.
      // Resizing once rather than per-format keeps the three outputs showing
      // exactly the same pixels.
      const mid = path.join(tmp, `${width}.png`);
      await execFileAsync("magick", [src + "[0]", "-auto-orient", "-resize", `${width}x`, "-strip", mid]);

      const jpg = `${slug}-${width}.jpg`;
      const webp = `${slug}-${width}.webp`;
      const avif = `${slug}-${width}.avif`;

      await Promise.all([
        execFileAsync("magick", [
          mid, "-quality", "82", "-sampling-factor", "4:2:0",
          "-interlace", "JPEG", "-strip", path.join(outDir, jpg),
        ]),
        execFileAsync("cwebp", ["-quiet", "-q", "78", "-m", "6", "-sharp_yuv", mid, "-o", path.join(outDir, webp)]),
        execFileAsync("avifenc", ["--speed", "6", "--qcolor", "58", "--jobs", "2", mid, path.join(outDir, avif)]),
      ]);

      files.push(jpg, webp, avif);
    }

    // LQIP: a 24px-wide WebP, inlined as a data URI so it costs no request and
    // is painted during the first HTML parse. CSS blurs and upscales it; the
    // real image cross-fades over the top once decoded.
    const lqipPng = path.join(tmp, "lqip.png");
    const lqipWebp = path.join(tmp, "lqip.webp");
    await execFileAsync("magick", [src + "[0]", "-auto-orient", "-resize", `${LQIP_WIDTH}x`, "-strip", lqipPng]);
    await execFileAsync("cwebp", ["-quiet", "-q", "42", "-m", "6", lqipPng, "-o", lqipWebp]);
    const lqip = "data:image/webp;base64," + fs.readFileSync(lqipWebp).toString("base64");

    const meta = { slug, width: w, height: h, widths, lqip, dominant: "#" + dominant.slice(0, 6).toLowerCase() };
    cache[slug] = { hash, files, meta };
    return meta;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ----------------------------------------------------------------- rendering

function srcset(meta, ext) {
  return meta.widths.map((w) => `img/${meta.slug}-${w}.${ext} ${w}w`).join(", ");
}

function fallbackSrc(meta) {
  const w = meta.widths.includes(800) ? 800 : meta.widths[meta.widths.length - 1];
  return `img/${meta.slug}-${w}.jpg`;
}

/**
 * A progressively-loading picture. The wrapper carries the aspect ratio, the
 * dominant colour and the inline LQIP, so the layout is final before any image
 * byte arrives — no reflow, and never a white hole.
 */
function picture(meta, { alt, sizes, eager = false, className = "", index = null }) {
  // Single quotes inside the url(): this lands in a double-quoted HTML
  // attribute, and a double quote here terminates it early and shreds the
  // whole <figure> tag. Base64 is [A-Za-z0-9+/=] only, so ' is always safe.
  const style = `--ar:${(meta.width / meta.height).toFixed(4)};--bg:${meta.dominant};--lqip:url('${meta.lqip}')`;
  const loading = eager ? `loading="eager" fetchpriority="high"` : `loading="lazy"`;
  const idx = index === null ? "" : ` data-index="${index}"`;
  return `<figure class="ph ${className}" style="${style}"${idx}>
  <picture>
    <source type="image/avif" srcset="${srcset(meta, "avif")}" sizes="${sizes}">
    <source type="image/webp" srcset="${srcset(meta, "webp")}" sizes="${sizes}">
    <img src="${fallbackSrc(meta)}" srcset="${srcset(meta, "jpg")}" sizes="${sizes}"
         width="${meta.width}" height="${meta.height}" alt="${esc(alt)}" ${loading} decoding="async">
  </picture>
</figure>`;
}

function specRows(car) {
  const v = car.vehicle;
  const s = car.sale;
  const rows = [
    ["Model", `${v.year} ${v.make} ${v.model}${v.variant ? " " + v.variant : ""}`],
    ["Engine", [v.engine, need(v.engineSize, "vehicle.engineSize")].filter(Boolean).join(" ") || null],
    ["Gearbox · Drive", v.transmission ? `${v.transmission} · ${v.drive}` : null, "vehicle.transmission"],
    ["Odometer", v.odometerKm, "vehicle.odometerKm", km],
    ["Seats", v.seats, "vehicle.seats"],
    ["Colour", v.colour, "vehicle.colour"],
    ["Registration", s.regoState && s.regoExpiry ? `${s.regoState}, valid until ${s.regoExpiry}` : null, "sale.regoState / sale.regoExpiry"],
    ["Last service", s.lastServiceDate ? `${s.lastServiceDate}${s.lastServiceKm ? ` at ${km(s.lastServiceKm)}` : ""}` : null, "sale.lastServiceDate"],
    ["Recently replaced", s.recentlyReplaced?.length ? s.recentlyReplaced.join(", ") : null, "sale.recentlyReplaced"],
    ["Included", car.included?.length ? car.included.join(", ") : null, "included"],
    ["Good to know", s.knownIssues, "sale.knownIssues"],
    ["Available from", s.availableFrom ? `${s.availableFrom}${s.location ? ` in ${s.location}` : ""}` : null, "sale.availableFrom"],
  ];

  return rows
    .map(([label, value, key, fmt]) => {
      const rendered = value === null || value === undefined
        ? val(null, key || label.toLowerCase())
        : esc(fmt ? fmt(value) : value);
      return `      <tr><th scope="row">${esc(label)}</th><td>${rendered}</td></tr>`;
    })
    .join("\n");
}

function contactBlock(car, { big = false } = {}) {
  const c = car.contact;
  const phone = need(c.phone, "contact.phone");
  const tel = phone ? phone.replace(/[^\d+]/g, "") : null;
  const cls = big ? "contact-big" : "";

  if (!phone) return `<p class="${cls}">${val(null, "contact.phone")}</p>`;

  const wa = c.whatsapp
    ? `<a class="link-alt" href="https://wa.me/${tel.replace(/^\+/, "")}">WhatsApp</a>`
    : "";
  const mail = c.email ? `<a class="link-alt" href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : "";

  return `<p class="${cls}"><a class="tel" href="tel:${esc(tel)}">${esc(phone)}</a></p>
    ${wa || mail ? `<p class="alt-contacts">${[wa, mail].filter(Boolean).join("<span class='sep'>·</span>")}</p>` : ""}`;
}

function render(car, photos) {
  const hero = photos[0];
  const rest = photos.slice(1);
  const v = car.vehicle;
  const vehicleName = `${v.year} ${v.make} ${v.model}`;

  const GALLERY_SIZES = "(min-width:1140px) 352px, (min-width:760px) 32vw, (min-width:520px) 48vw, 94vw";

  const price = need(car.sale.priceAud, "sale.priceAud");
  const odo = need(v.odometerKm, "vehicle.odometerKm");

  // Google/Bing understand this; it is also what makes a shared link in a
  // WhatsApp group render with the price instead of a bare URL.
  const ld = {
    "@context": "https://schema.org",
    "@type": "Car",
    name: vehicleName,
    brand: { "@type": "Brand", name: v.make },
    model: v.model,
    vehicleModelDate: String(v.year),
    fuelType: v.fuel,
    driveWheelConfiguration: v.drive,
    ...(odo && { mileageFromOdometer: { "@type": "QuantitativeValue", value: odo, unitCode: "KMT" } }),
    ...(price && {
      offers: {
        "@type": "Offer",
        price: price,
        priceCurrency: "AUD",
        availability: "https://schema.org/InStock",
        ...(car.sale.location && { areaServed: car.sale.location }),
      },
    }),
  };

  const note = (car.note.body || [])
    .map((p, i) => (p === null ? `<p>${val(null, `note.body[${i}]`)}</p>` : `<p>${esc(p)}</p>`))
    .join("\n      ");

  const stats = [
    ["Price", price ? money(price) + (car.sale.negotiable ? " <span class='ono'>ono</span>" : "") : val(null, "sale.priceAud")],
    ["Odometer", odo ? esc(km(odo)) : val(null, "vehicle.odometerKm")],
    ["Rego", car.sale.regoState && car.sale.regoExpiry ? esc(`${car.sale.regoState} · ${car.sale.regoExpiry}`) : val(null, "sale.regoState")],
    ["Gearbox", v.transmission ? esc(v.transmission) : val(null, "vehicle.transmission")],
  ];

  const css = fs.readFileSync(P("src", "styles.css"), "utf8");

  return `<!doctype html>
<html lang="${esc(car.site.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(car.site.title)}</title>
<meta name="description" content="${esc(car.site.description)}">
<meta name="theme-color" content="#f5f1ea">
<link rel="canonical" href="https://${esc(car.site.domain)}/">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(car.site.title)}">
<meta property="og:description" content="${esc(car.site.description)}">
<meta property="og:url" content="https://${esc(car.site.domain)}/">
<meta property="og:image" content="https://${esc(car.site.domain)}/img/${hero.meta.slug}-1200.jpg">
<meta name="twitter:card" content="summary_large_image">

<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-icon.png">

<link rel="preload" href="fonts/instrument-serif-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" as="image" imagesrcset="${srcset(hero.meta, "avif")}" imagesizes="100vw" type="image/avif" fetchpriority="high">

<style>${css}</style>
<script>
// Capture phase: the load event does not bubble, and an image served from
// cache can finish before this file is even parsed — the DOMContentLoaded
// sweep below catches those. Without both, a cached image stays invisible.
addEventListener("load", function (e) {
  var t = e.target;
  if (t && t.tagName === "IMG") { var f = t.closest(".ph"); if (f) f.setAttribute("data-loaded", ""); }
}, true);
addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll(".ph img").forEach(function (img) {
    if (img.complete && img.naturalWidth > 0) img.closest(".ph").setAttribute("data-loaded", "");
  });
});
</script>
<noscript><style>.ph img{opacity:1}.ph::before{opacity:0}</style></noscript>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
</head>
<body>

<a class="skip" href="#details">Skip to the details</a>

<header class="hero">
  ${picture(hero.meta, { alt: hero.alt || vehicleName, sizes: "100vw", eager: true, className: "hero-img", index: 0 })}
  <div class="hero-text">
    <p class="eyebrow">${esc(car.hero.eyebrow)}</p>
    <h1>${esc(car.hero.headline)}</h1>
    <p class="lede">${esc(car.hero.lede)}</p>
  </div>
</header>

<section class="stats" aria-label="Key facts">
  <dl>
${stats.map(([k, v2]) => `    <div><dt>${esc(k)}</dt><dd>${v2}</dd></div>`).join("\n")}
  </dl>
</section>

<section class="gallery" aria-label="Photos">
  <h2 class="sr-only">Photos</h2>
  <div class="grid">
${rest.map((p, i) => picture(p.meta, { alt: p.alt || vehicleName, sizes: GALLERY_SIZES, index: i + 1 })).join("\n")}
  </div>
  <p class="gallery-hint">Tap a photo to open it full size.</p>
</section>

<section class="note" aria-labelledby="note-h">
  <p class="eyebrow">${esc(car.note.heading)}</p>
  <h2 id="note-h" class="sr-only">${esc(car.note.heading)}</h2>
  <div class="prose">
      ${note}
  </div>
  <p class="signoff">${val(car.note.author, "note.author")}</p>
</section>

<section class="details" id="details" aria-labelledby="details-h">
  <p class="eyebrow">For sale · ${esc(vehicleName)}</p>
  <h2 id="details-h">The honest details.</h2>
  <table>
    <tbody>
${specRows(car)}
    </tbody>
  </table>
</section>

<section class="contact" id="contact" aria-labelledby="contact-h">
  <p class="eyebrow">Call or text</p>
  <h2 id="contact-h" class="sr-only">Contact</h2>
  ${contactBlock(car, { big: true })}
  ${car.contact.name ? `<p class="who">${esc(car.contact.name)}${car.sale.location ? ` · ${esc(car.sale.location)}` : ""}</p>` : val(null, "contact.name")}
  <p class="contact-note">${esc(car.contact.note)}</p>
</section>

<footer>
  <p>${esc(vehicleName)} · ${esc(car.site.domain)}</p>
</footer>

<div class="lightbox" id="lightbox" hidden role="dialog" aria-modal="true" aria-label="Photo viewer">
  <button class="lb-close" type="button" aria-label="Close">&times;</button>
  <button class="lb-prev" type="button" aria-label="Previous photo">&#8249;</button>
  <button class="lb-next" type="button" aria-label="Next photo">&#8250;</button>
  <div class="lb-stage"></div>
  <p class="lb-count" aria-live="polite"></p>
</div>

<script src="app.js" defer></script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------- main

async function main() {
  const car = JSON.parse(fs.readFileSync(P("content", "car.json"), "utf8"));

  const files = fs
    .readdirSync(P("photos"))
    .filter((f) => /\.(jpe?g|png|webp|avif|heic)$/i.test(f))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

  if (files.length === 0) throw new Error("photos/ is empty — nothing to build");

  // Per-photo alt text and ordering. Regenerated as a scaffold when photos
  // appear that it does not know about, so dropping in new files just works.
  const capFile = P("content", "photos.json");
  const caps = fs.existsSync(capFile) ? JSON.parse(fs.readFileSync(capFile, "utf8")) : {};
  let capsChanged = false;
  for (const f of files) {
    if (!(f in caps)) {
      caps[f] = { alt: null };
      capsChanged = true;
    }
  }
  if (capsChanged) {
    fs.writeFileSync(capFile, JSON.stringify(caps, null, 2) + "\n");
    warnings.push(`content/photos.json was extended with new photos — add alt text there`);
  }

  console.log(`→ ${files.length} photos, ${WIDTHS.length} widths, 3 formats`);
  const t0 = Date.now();

  const metas = await pool(files, Math.max(2, os.cpus().length), async (f) => {
    const meta = await processPhoto(P("photos", f));
    process.stdout.write(".");
    return { meta, alt: caps[f]?.alt ?? null };
  });
  process.stdout.write("\n");

  for (const [i, f] of files.entries()) {
    if (!caps[f]?.alt) missing.push(`photos.json: alt text for ${f}`);
    void i;
  }

  fs.mkdirSync(P(".cache"), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

  // Static passthrough: fonts, favicon, CNAME, .nojekyll
  for (const dir of ["public", "src/fonts"]) {
    const from = P(dir);
    if (!fs.existsSync(from)) continue;
    const to = dir === "src/fonts" ? P("dist", "fonts") : P("dist");
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }
  fs.copyFileSync(P("src", "app.js"), P("dist", "app.js"));

  fs.writeFileSync(P("dist", "index.html"), render(car, metas));

  const bytes = (p) => fs.statSync(p).size;
  const html = bytes(P("dist", "index.html"));
  const imgTotal = fs
    .readdirSync(P("dist", "img"))
    .reduce((n, f) => n + bytes(P("dist", "img", f)), 0);

  console.log(`✓ dist/index.html  ${(html / 1024).toFixed(1)} kB (CSS inlined)`);
  console.log(`✓ dist/img/        ${(imgTotal / 1024 / 1024).toFixed(1)} MB across all formats and widths`);
  console.log(`  built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  for (const w of [...new Set(warnings)]) console.log(`! ${w}`);

  if (missing.length) {
    const list = [...new Set(missing)];
    console.log(`\n${list.length} field(s) still unfilled in content/:`);
    for (const m of list) console.log(`   · ${m}`);
    if (STRICT) {
      console.error("\n✗ --strict: refusing to publish a site with placeholders on it.");
      process.exit(1);
    }
    console.log("   (rendered as amber 'missing' markers — the build is local-only until these are filled)");
  }

  if (SERVE) {
    const { createServer } = await import("node:http");
    const types = { ".html": "text/html", ".js": "text/javascript", ".jpg": "image/jpeg", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
    createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split("?")[0]);
      let file = path.join(P("dist"), rel === "/" ? "index.html" : rel);
      if (!file.startsWith(P("dist")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    }).listen(8080, () => console.log("\n→ http://localhost:8080"));
  }
}

main().catch((e) => {
  console.error("✗ " + e.message);
  process.exit(1);
});
