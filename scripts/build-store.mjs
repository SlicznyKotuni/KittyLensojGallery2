// Buduje magazyn zdjęć KittyLensoj:
//   images/<obiektyw>/<plik>   ->  dist/images/<obiektyw>/<plik>        (hardlink, bez kopiowania)
//   miniatura 640px WebP       ->  dist/thumbs/<obiektyw>/<plik>.webp
//   lista dla strony głównej   ->  dist/index.json
//
// Miniatury trzymane w .thumbcache (cache GitHub Actions), więc po każdym pushu
// generowane są tylko NOWE zdjęcia. Parametry takie jak w .eleventy.js strony głównej.

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const IMAGES_DIR = "images";
const CACHE_DIR = ".thumbcache";
const DIST_DIR = "dist";
const THUMB_WIDTH = 640;
const IMG_RE = /\.(jpg|jpeg|png|gif|avif|av1|webp)$/i;

// Limit Cloudflare Pages = 20 000 plików na wdrożenie.
const WARN_FILES = 16000;
const MAX_FILES = 19000;

sharp.cache(false);
sharp.concurrency(2);

if (!fs.existsSync(IMAGES_DIR)) {
  console.error(`Brak folderu ${IMAGES_DIR}/`);
  process.exit(1);
}

fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

function link(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.linkSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
  }
}

// --- zbierz listę zdjęć ---
const jobs = [];
for (const d of fs.readdirSync(IMAGES_DIR, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const file of fs.readdirSync(path.join(IMAGES_DIR, d.name))) {
    if (IMG_RE.test(file)) jobs.push({ lens: d.name, file });
  }
}

const totalFiles = jobs.length * 2 + 1; // oryginały + miniatury + index.json
console.log(`Zdjęć: ${jobs.length}, plików we wdrożeniu (max): ~${totalFiles}`);
if (totalFiles > MAX_FILES) {
  console.error(
    `\nMAGAZYN PEŁNY: ${totalFiles} plików > ${MAX_FILES}. ` +
      `Limit Cloudflare Pages to 20 000. Nowe zdjęcia wrzuć do kolejnego magazynu (Gallery3).`
  );
  process.exit(1);
}
if (totalFiles > WARN_FILES) {
  console.warn(`UWAGA: magazyn zapełniony w ${Math.round((totalFiles / 20000) * 100)}%. Przygotuj kolejny.`);
}

// --- miniatury + index ---
const entries = new Array(jobs.length);
let made = 0;
let reused = 0;
let failed = 0;

async function processJob(i) {
  const { lens, file } = jobs[i];
  const srcPath = path.join(IMAGES_DIR, lens, file);
  const rel = `thumbs/${lens}/${file}.webp`;
  const cachePath = path.join(CACHE_DIR, rel);
  const distThumb = path.join(DIST_DIR, rel);

  link(srcPath, path.join(DIST_DIR, "images", lens, file));

  let w = null;
  let h = null;
  let t = null;
  try {
    if (!fs.existsSync(cachePath)) {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      await sharp(srcPath, { sequentialRead: true, failOn: "none" })
        .rotate()
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .webp({ quality: 72, effort: 2 })
        .toFile(cachePath);
      made++;
    } else {
      reused++;
    }
    const meta = await sharp(cachePath).metadata();
    w = meta.width;
    h = meta.height;
    t = rel;
    link(cachePath, distThumb);
  } catch (e) {
    failed++;
    console.warn(`Miniatura nieudana: ${srcPath}: ${e.message}`);
    try { fs.rmSync(cachePath, { force: true }); } catch {}
  }

  const entry = { lens, filename: file };
  if (t) Object.assign(entry, { t, w, h });
  entries[i] = entry;
}

const POOL = 4;
let next = 0;
await Promise.all(
  Array.from({ length: POOL }, async () => {
    while (next < jobs.length) {
      const i = next++;
      await processJob(i);
      const done = made + reused + failed;
      if (done % 500 === 0) console.log(`  ... ${done}/${jobs.length}`);
    }
  })
);

fs.writeFileSync(
  path.join(DIST_DIR, "index.json"),
  JSON.stringify({ version: 1, generated: new Date().toISOString(), images: entries })
);

console.log(`Gotowe. Nowe miniatury: ${made}, z cache: ${reused}, nieudane: ${failed}`);
