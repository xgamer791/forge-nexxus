// The pixel gate's own arithmetic: zip reading, which screenshot belongs to
// a part, and that identical pixels pass while more than 0.1% do not.
// No browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bandFor, compareShot, decodePng, diffRatio, encodePng, imagesFromZip, packZip, readZip, selectShotPaths,
} from "../visual.mjs";

const NAMES = [
  "reference-tacos-design/screens/scroll/scroll-000.png",
  "reference-tacos-design/screens/scroll/scroll-017.png",
  "reference-tacos-design/screens/scroll/scroll-050.png",
  "reference-tacos-design/screens/scroll/scroll-100.png",
  "reference-tacos-design/screens/pages/home.png",
  "reference-tacos-design/screens/pages/food-menu.png",
  "reference-tacos-design/screens/sections/hero.png",
  "reference-tacos-design/fonts/satoshi.woff2",
];

test("each part is pointed at the SkillUI screenshot for that band", () => {
  assert.deepEqual(selectShotPaths(NAMES, "header", "/"), [
    "reference-tacos-design/screens/scroll/scroll-000.png",
    "reference-tacos-design/screens/pages/home.png",
    "reference-tacos-design/screens/sections/hero.png",
  ]);
  assert.equal(selectShotPaths(NAMES, "footer", "/food-menu")[0], "reference-tacos-design/screens/scroll/scroll-100.png");
  assert.ok(selectShotPaths(NAMES, "body2", "/food-menu").includes("reference-tacos-design/screens/scroll/scroll-050.png"));
  assert.ok(selectShotPaths(NAMES, "body1", "/food-menu").includes("reference-tacos-design/screens/pages/food-menu.png"));
  assert.deepEqual(bandFor("screens/scroll/scroll-000.png", "header"), [0, 0.22]);
  assert.deepEqual(bandFor("screens/scroll/scroll-100.png", "footer"), [0.7, 1]);
  assert.deepEqual(bandFor("screens/pages/home.png", "header"), [0, 0.14]);
  assert.deepEqual(bandFor("screens/sections/hero.png", "body1"), [0, 1]);
});

test("a png round-trips, and the pixel budget is 0.1%", () => {
  const width = 40;
  const height = 25;
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 10; rgba[i + 1] = 20; rgba[i + 2] = 30; }
  const decoded = decodePng(encodePng(width, height, rgba));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.equal(diffRatio(decoded.rgba, rgba).ratio, 0);
  const one = Buffer.from(rgba);
  one[0] = 11;
  assert.equal(diffRatio(one, rgba).differing, 1);
  assert.ok(diffRatio(one, rgba).ratio <= 0.001);
  const two = Buffer.from(rgba);
  two[0] = 11;
  two[4] = 12;
  assert.ok(diffRatio(two, rgba).ratio > 0.001);
  const same = compareShot(decoded, decoded, [0, 1]);
  assert.equal(same.ratio, 0);
});

test("a deflated skill zip yields the reference png for the part", () => {
  const png = encodePng(2, 2, Buffer.from([
    1, 2, 3, 255, 1, 2, 3, 255,
    1, 2, 3, 255, 1, 2, 3, 255,
  ]));
  const zip = packZip({
    "reference-tacos-design/screens/scroll/scroll-000.png": png,
    "reference-tacos-design/screens/scroll/scroll-100.png": png,
    "reference-tacos-design/fonts/satoshi.woff2": Buffer.from("font"),
  }, 8);
  const files = readZip(zip);
  assert.equal(files.get("reference-tacos-design/screens/scroll/scroll-000.png")?.length, png.length);
  const shots = imagesFromZip(zip, "header", "/");
  assert.equal(shots.length, 1);
  assert.equal(shots[0].name, "reference-tacos-design/screens/scroll/scroll-000.png");
  assert.equal(shots[0].width, 2);
});
