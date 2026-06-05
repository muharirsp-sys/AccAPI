/**
 * Script untuk generate PWA icons PNG dari SVG template.
 * Jalankan: node scripts/generate-icons.js
 * Dependensi: sharp (devDependency)
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ICONS_DIR = path.join(__dirname, "..", "public", "icons");

if (!fs.existsSync(ICONS_DIR)) {
  fs.mkdirSync(ICONS_DIR, { recursive: true });
}

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

function generateSVG(size, maskable = false) {
  const padding = maskable ? Math.round(size * 0.1) : 0;
  const innerSize = size - padding * 2;
  const cornerRadius = maskable ? 0 : Math.round(innerSize * 0.18);
  const fontSize = Math.round(innerSize * 0.32);
  const subFontSize = Math.round(innerSize * 0.12);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${maskable ? `<rect width="${size}" height="${size}" fill="#f7efe1"/>` : ""}
  <defs>
    <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f2d28a"/>
      <stop offset="52%" stop-color="#c79a3f"/>
      <stop offset="100%" stop-color="#7a4e20"/>
    </linearGradient>
  </defs>
  <rect x="${padding}" y="${padding}" width="${innerSize}" height="${innerSize}" rx="${cornerRadius}" fill="url(#g)"/>
  <text x="${size / 2}" y="${size * 0.44}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold" fill="#3d2814">S</text>
  <text x="${size / 2}" y="${size * 0.68}" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="${subFontSize}" font-weight="700" fill="#5f4220">ERP</text>
</svg>`;
}

async function main() {
  // Generate regular icons
  for (const size of sizes) {
    const svg = Buffer.from(generateSVG(size, false));
    await sharp(svg).resize(size, size).png().toFile(path.join(ICONS_DIR, `icon-${size}x${size}.png`));
    console.log(`✓ icon-${size}x${size}.png`);
  }

  // Generate maskable icons
  for (const size of [192, 512]) {
    const svg = Buffer.from(generateSVG(size, true));
    await sharp(svg).resize(size, size).png().toFile(path.join(ICONS_DIR, `icon-maskable-${size}x${size}.png`));
    console.log(`✓ icon-maskable-${size}x${size}.png`);
  }

  // Apple touch icon (180x180)
  const appleSvg = Buffer.from(generateSVG(180, false));
  await sharp(appleSvg).resize(180, 180).png().toFile(path.join(ICONS_DIR, "apple-touch-icon.png"));
  console.log("✓ apple-touch-icon.png");

  // Favicon 32x32
  const favSvg = Buffer.from(generateSVG(32, false));
  await sharp(favSvg).resize(32, 32).png().toFile(path.join(ICONS_DIR, "favicon-32x32.png"));
  console.log("✓ favicon-32x32.png");

  // Favicon 16x16
  const fav16Svg = Buffer.from(generateSVG(16, false));
  await sharp(fav16Svg).resize(16, 16).png().toFile(path.join(ICONS_DIR, "favicon-16x16.png"));
  console.log("✓ favicon-16x16.png");

  // Screenshot placeholder wide
  const wideScreenshot = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <rect width="1280" height="720" fill="#f7efe1"/>
    <rect x="0" y="0" width="260" height="720" fill="rgba(255,250,239,0.95)" stroke="rgba(176,125,43,0.24)" stroke-width="1"/>
    <rect x="0" y="0" width="1280" height="64" fill="rgba(255,250,239,0.88)" stroke="rgba(176,125,43,0.14)" stroke-width="1"/>
    <text x="130" y="40" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#2d241b">Smart ERP</text>
    <text x="770" y="380" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" fill="#5f5142">Dashboard Overview</text>
  </svg>`;
  await sharp(Buffer.from(wideScreenshot)).resize(1280, 720).png().toFile(path.join(ICONS_DIR, "screenshot-wide.png"));
  console.log("✓ screenshot-wide.png");

  // Screenshot placeholder narrow (mobile)
  const narrowScreenshot = `<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">
    <rect width="390" height="844" fill="#f7efe1"/>
    <rect x="0" y="0" width="390" height="56" fill="rgba(255,250,239,0.92)" stroke="rgba(176,125,43,0.14)" stroke-width="1"/>
    <text x="195" y="36" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#2d241b">Smart ERP</text>
    <text x="195" y="420" text-anchor="middle" font-family="Arial,sans-serif" font-size="20" fill="#5f5142">Dashboard</text>
  </svg>`;
  await sharp(Buffer.from(narrowScreenshot)).resize(390, 844).png().toFile(path.join(ICONS_DIR, "screenshot-narrow.png"));
  console.log("✓ screenshot-narrow.png");

  // Clean up SVG files
  const svgFiles = fs.readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg"));
  for (const f of svgFiles) {
    fs.unlinkSync(path.join(ICONS_DIR, f));
  }

  console.log("\n✓ Semua PWA icons berhasil di-generate!");
}

main().catch(console.error);
