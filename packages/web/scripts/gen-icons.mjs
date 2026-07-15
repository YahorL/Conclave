import { fileURLToPath } from "node:url";
import sharp from "sharp";

const src = fileURLToPath(new URL("../public/icon.svg", import.meta.url));
for (const size of [192, 512]) {
  const out = fileURLToPath(new URL(`../public/icon-${size}.png`, import.meta.url));
  await sharp(src).resize(size, size).png().toFile(out);
  console.log(`wrote ${out}`);
}
