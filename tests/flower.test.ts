import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { ImageRenderable } from "@opentui/core";
import { Orb } from "../src/ui/components/Orb.tsx";
import {
  LIGHT_FROM,
  GLYPH_RAMP,
  brightnessColor,
  brightnessGlyph,
  flowerColors,
  lightDirection,
  orbSize,
  orbToString,
  petalRadius,
  phaseAt,
  renderOrb,
  renderPixels,
  rasterizeFlower,
  renderFlowerRaster,
  windLean,
} from "../src/ui/orb.ts";
import { palette } from "../src/ui/theme.ts";

const lines = (t: number, w: number, h: number) => orbToString(renderOrb(t, w, h)).split("\n");
const glyphInk = (ch: string) => ({ " ": 0, "·": 0.125, "░": 0.25, "▒": 0.5, "▓": 0.75, "█": 1 })[ch] ?? 0;
const rowInk = (line: string) => [...line].reduce((n, c) => n + glyphInk(c), 0);
const inkCount = (rows: string[]) => rows.reduce((n, r) => n + rowInk(r), 0);

/** Mean density change, normalised so finer shade steps don't count as jumps. */
function cellDelta(a: string[], b: string[]): number {
  let diff = 0;
  let total = 0;
  a.forEach((row, i) => {
    const ra = [...row];
    const rb = [...b[i]!];
    for (let x = 0; x < ra.length; x++) {
      total++;
      diff += Math.abs(glyphInk(ra[x]!) - glyphInk(rb[x]!));
    }
  });
  return diff / total;
}

/** Bounding box of drawn cells. */
function box(rows: string[]): { w: number; h: number } {
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  rows.forEach((row, y) => {
    [...row].forEach((c, x) => {
      if (c === " ") return;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    });
  });
  return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Mean brightness of drawn pixels inside a quadrant of the field. */
function quadrantMean(t: number, w: number, h: number, right: boolean, bottom: boolean): number {
  const f = renderPixels(t, w, h);
  let sum = 0;
  let n = 0;
  for (let y = 0; y < f.py; y++) {
    if (y >= f.py / 2 !== bottom) continue;
    for (let x = 0; x < f.px; x++) {
      if (x >= f.px / 2 !== right) continue;
      const b = f.data[y * f.px + x]!;
      if (b < 0) continue;
      sum += b;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

const BUD = 0.8;
const FULL = 12;
const W = 57;
const H = 28;

describe("flower sizing", () => {
  test("fits the available space with a 2:1 aspect and clamps small terminals", () => {
    const big = orbSize(120, 40);
    expect(big.height).toBe(38);
    expect(orbSize(180, 60).height).toBe(40);
    expect(big.width).toBe(big.height * 2 + 1);
    const short = orbSize(80, 9);
    expect(short.height).toBe(7);
    expect(short.width).toBe(15);
    const narrow = orbSize(20, 30);
    expect(narrow.width).toBeLessThanOrEqual(20);
    expect(narrow.height).toBe(Math.floor((narrow.width - 1) / 2));
    const tiny = orbSize(8, 3);
    expect(tiny.height).toBe(5); // floor, still renders
  });
});

describe("flower lifecycle", () => {
  test("opens once, stays present and fully closes at varied times", () => {
    expect(phaseAt(0)).toEqual({ bloom: 0, presence: 1 });
    expect(phaseAt(BUD).bloom).toBe(0);
    expect(phaseAt(5).bloom).toBeGreaterThan(0.1);
    expect(phaseAt(5).bloom).toBeLessThan(0.9);
    expect(phaseAt(FULL)).toEqual({ bloom: 1, presence: 1 });
    const starts: number[] = [];
    for (let window = 0; window < 8; window++) {
      const blooms = Array.from({ length: 32 }, (_, i) => phaseAt(12 + window * 32 + i).bloom);
      starts.push(blooms.findIndex((b) => b < 0.99));
      expect(blooms[0]).toBe(1);
      expect(blooms[31]).toBe(1);
      expect(Math.min(...blooms)).toBe(0);
    }
    expect(new Set(starts).size).toBeGreaterThan(2);
    for (const seed of [0, 13, 997]) {
      for (let t = 0; t < 600; t += 2) {
        expect(phaseAt(t, seed).presence).toBe(1);
        expect(orbToString(renderOrb(t, 21, 10, seed)).trim().length).toBeGreaterThan(10);
        expect(Math.abs(phaseAt(t + 0.1, seed).bloom - phaseAt(t, seed).bloom)).toBeLessThan(0.04);
      }
    }
  });

  test("every seed visibly closes into a bud within 24 seconds and reopens", () => {
    for (let seed = 0; seed < 30; seed++) {
      const closedAt = Array.from({ length: 49 }, (_, i) => 12 + i / 4)
        .find((t) => phaseAt(t, seed).bloom === 0);
      expect(closedAt).toBeDefined();
      const closed = box(orbToString(renderOrb(closedAt!, W, H, seed)).split("\n"));
      const open = box(orbToString(renderOrb(FULL, W, H, seed)).split("\n"));
      expect(closed.w).toBeLessThan(open.w * 0.5);
      expect(closed.h).toBeLessThan(open.h * 0.5);
      expect(phaseAt(38, seed).bloom).toBe(1);
    }
  });

  test("does not repeat the old loop and is reproducible for a session seed", () => {
    expect(renderOrb(33, W, H, 42)).toEqual(renderOrb(33, W, H, 42));
    expect(renderOrb(33, W, H, 42)).not.toEqual(renderOrb(33, W, H, 43));
    expect(phaseAt(20, 42)).not.toEqual(phaseAt(20, 43));
    for (const t of [3, 12, 40, 80, 160]) {
      expect(lines(t, W, H)).not.toEqual(lines(t + 18, W, H));
    }
  });

  test("the bud is small and the full bloom fills the box, with no stem", () => {
    const bud = box(lines(BUD, W, H));
    const full = box(lines(FULL, W, H));
    expect(bud.w).toBeLessThan(full.w * 0.45);
    expect(bud.h).toBeLessThan(full.h * 0.5);
    expect(full.w).toBeGreaterThanOrEqual(W - 8);
    expect(full.h).toBeGreaterThanOrEqual(H - 2);
    // Nothing narrow hangs below the head at any stage: the lowest drawn rows
    // are petal tips, not a column.
    for (const t of [BUD, 5, FULL]) {
      const rows = lines(t, W, H);
      const widths = rows.map((r) => r.trim().length).filter((w) => w > 0);
      const bottom = widths.slice(-4);
      expect(bottom.reduce((a, b) => a + b, 0) / bottom.length).toBeGreaterThanOrEqual(5);
      expect(widths.slice(-8).filter((w) => w <= 3).length).toBeLessThanOrEqual(2);
    }
  });

  test("opens steadily and never jumps between frames", () => {
    const inks = [2, 4, 6, 8, 10].map((t) => inkCount(lines(t, W, H)));
    for (let i = 1; i < inks.length; i++) expect(inks[i]!).toBeGreaterThan(inks[i - 1]! * 1.05);
    // Render each frame once and compare it with the previous one.
    let previous = lines(0, W, H);
    for (let t = 0; t < 90; t += 0.1) {
      const next = lines(t + 0.1, W, H);
      expect(cellDelta(previous, next)).toBeLessThan(0.04);
      previous = next;
    }
    // Between rests, only the wind, petal flex and light change.
    const a = inkCount(lines(11, W, H));
    const b = inkCount(lines(14, W, H));
    expect(Math.max(a, b) / Math.min(a, b)).toBeLessThan(1.15);
    expect(orbToString(renderOrb(11, W, H))).not.toBe(orbToString(renderOrb(14, W, H)));
    // Renders ~900 frames; shared CI runners are several times slower than a laptop.
  }, 30000);
});

describe("lighting", () => {
  test("light comes from the upper left, in front, and drifts slowly", () => {
    for (const t of [0, 5, 9, 13]) {
      const [x, y, z] = lightDirection(t);
      expect(x).toBeLessThan(0);
      expect(y).toBeLessThan(0);
      expect(z).toBeGreaterThan(0.4);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
    }
    expect(lightDirection(4)).not.toEqual(lightDirection(8));
    expect(lightDirection(22)).not.toEqual(lightDirection(4));
  });

  test("the lit side of the flower is brighter than the far side", () => {
    for (const t of [BUD, 6, FULL]) {
      expect(quadrantMean(t, W, H, false, false)).toBeGreaterThan(quadrantMean(t, W, H, true, true) * 1.15);
    }
  });

  test("brightness spans dark blue to white with speculars in the minority", () => {
    const f = renderPixels(FULL, W, H);
    const drawn = Array.from(f.data).filter((b) => b >= 0);
    expect(Math.min(...drawn)).toBeLessThan(0.2);
    expect(Math.max(...drawn)).toBeGreaterThan(0.9);
    const bright = drawn.filter((b) => b > 0.75).length;
    expect(bright).toBeGreaterThan(drawn.length * 0.02);
    expect(bright).toBeLessThan(drawn.length * 0.3);
    expect(brightnessColor(0)).not.toBe(flowerColors.body);
    expect(brightnessColor(1)).toBe(flowerColors.light);
    expect(brightnessColor(LIGHT_FROM)).toBe(flowerColors.body);
  });
});

describe("flower frames", () => {
  test("brightness alone selects characters from sparse to dense", () => {
    expect(brightnessGlyph(0)).toBe(" ");
    expect(brightnessGlyph(1)).toBe(GLYPH_RAMP.at(-1)!);
    let previous = 0;
    const chars = new Set<string>();
    for (let i = 0; i <= 100; i++) {
      const b = i / 100;
      const ch = brightnessGlyph(b);
      expect(GLYPH_RAMP.indexOf(ch)).toBeGreaterThanOrEqual(previous);
      previous = GLYPH_RAMP.indexOf(ch);
      chars.add(ch);
    }
    expect(chars.size).toBe(GLYPH_RAMP.length);
    expect(brightnessGlyph(0.08)).toBe("·");
    expect(brightnessGlyph(0.15)).toBe("░");
    expect(brightnessGlyph(0.4)).toBe("▒");
    expect(brightnessGlyph(0.65)).toBe("▓");
    expect(brightnessGlyph(0.9)).toBe("█");
    // Subtle differences still have distinct colour within each block density.
    expect(brightnessColor(0.15)).not.toBe(brightnessColor(0.18));
  });

  test("frames are deterministic, exactly sized, merged into runs and shaded in many levels", () => {
    const a = renderOrb(FULL, W, H);
    const b = renderOrb(FULL, W, H);
    expect(orbToString(a)).toBe(orbToString(b));
    expect(a.rows).toHaveLength(H);
    for (const row of a.rows) {
      const text = row.map((r) => r.text).join("");
      expect([...text].length).toBe(W);
      for (const run of row) expect(run.text.length).toBeGreaterThan(0);
      for (let i = 1; i < row.length; i++) expect(row[i]!.color).not.toBe(row[i - 1]!.color);
    }
    const colours = new Set(a.rows.flat().map((r) => r.color));
    expect(colours.has(palette.bg)).toBe(true);
    expect(colours.size).toBeGreaterThan(25);
    for (const c of colours) expect(/^#[0-9a-f]{6}$/.test(c)).toBe(true);
    // Blank cells are spaces on the background, never invisible glyphs.
    for (const run of a.rows.flat()) {
      if (run.color === palette.bg) expect(run.text).toMatch(/^ +$/);
      else for (const ch of run.text) expect(GLYPH_RAMP.slice(1)).toContain(ch);
    }
  });

  test("uses block shading with a faint step at the edges", () => {
    for (const t of [BUD, 5, FULL, 15.4]) {
      const text = lines(t, W, H).join("\n");
      for (const ch of text.replaceAll("\n", "")) expect(GLYPH_RAMP).toContain(ch);
      expect(text).toMatch(/^[ ·░▒▓█\n]+$/);
      expect(text).toContain("·");
      expect(new Set(text.replaceAll("\n", "").trim()).size).toBeGreaterThanOrEqual(4);

    }
  });

  test("character density follows brightness", () => {
    const frame = renderOrb(FULL, W, H);
    const f = renderPixels(FULL, W, H);
    let bright = 0;
    let brightN = 0;
    let dark = 0;
    let darkN = 0;
    frame.rows.forEach((runs, cy) => {
      let cx = 0;
      for (const run of runs) {
        for (const ch of run.text) {
          let sum = 0;
          let n = 0;
          for (let dy = 0; dy < 4; dy++)
            for (let dx = 0; dx < 2; dx++) {
              const b = f.data[(cy * 4 + dy) * f.px + cx * 2 + dx]!;
              if (b >= 0) {
                sum += b;
                n++;
              }
            }
          if (n === 8) {
            if (sum / n > 0.7) {
              bright += GLYPH_RAMP.indexOf(ch);
              brightN++;
            } else if (sum / n < 0.3) {
              dark += GLYPH_RAMP.indexOf(ch);
              darkN++;
            }
          }
          cx++;
        }
      }
    });
    expect(brightN).toBeGreaterThan(5);
    expect(darkN).toBeGreaterThan(5);
    expect(bright / brightN).toBeGreaterThan((dark / darkN) * 1.5);
  });

  test("has a floral silhouette: a jagged, roughly round head", () => {
    const rows = lines(FULL, W, H);
    const widths = rows.map((r) => r.trim().length);
    const widest = widths.indexOf(Math.max(...widths));
    expect(widest).toBeGreaterThan(H * 0.25);
    expect(widest).toBeLessThan(H * 0.8);
    let jagged = 0;
    for (let i = 1; i < widths.length - 1; i++) if (Math.abs(widths[i]! - (widths[i - 1]! + widths[i + 1]!) / 2) >= 2) jagged++;
    expect(jagged).toBeGreaterThanOrEqual(3);
  });

  test("petal extent is irregular and bounded, and closed petals hug the bud", () => {
    const open = Array.from({ length: 64 }, (_, i) => petalRadius((i / 64) * Math.PI * 2 - Math.PI, 1));
    expect(Math.min(...open)).toBeGreaterThan(0.2);
    expect(Math.max(...open)).toBeLessThanOrEqual(1.25);
    expect(Math.max(...open) - Math.min(...open)).toBeGreaterThan(0.3);
    const closed = Array.from({ length: 64 }, (_, i) => petalRadius((i / 64) * Math.PI * 2 - Math.PI, 0));
    expect(Math.max(...closed)).toBeLessThan(Math.max(...open) * 0.6);
  });

  test("sways slowly and the lean is bounded", () => {
    const leans = Array.from({ length: 200 }, (_, i) => windLean(i * 0.1));
    expect(Math.max(...leans)).toBeLessThanOrEqual(1);
    expect(Math.min(...leans)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...leans) - Math.min(...leans)).toBeGreaterThan(1);
    expect(windLean(19)).not.toBeCloseTo(windLean(1), 3);
    for (let t = 0; t < 600; t += 0.1) {
      expect(Math.abs(windLean(t + 0.1) - windLean(t))).toBeLessThan(0.05);
    }
  });

  test("small and narrow sizes still draw a compact bloom inside bounds", () => {
    for (const [w, h] of [
      [13, 6],
      [11, 5],
      [21, 10],
    ] as const) {
      const rows = lines(FULL, w, h);
      expect(rows).toHaveLength(h);
      for (const r of rows) expect([...r].length).toBe(w);
      expect(inkCount(rows)).toBeGreaterThan(w * h * 0.15);
      expect(rows[0]!.trim().length).toBeLessThan(rows[Math.floor(h / 2)]!.trim().length);
    }
  });
});

describe("Orb component", () => {
  test("uses a denser image inside the same layout when graphics become available", async () => {
    const setup = await testRender(createElement(Orb, { width: 60, height: 20, animate: false }), { width: 60, height: 20, exitOnCtrlC: false });
    try {
      await setup.renderOnce();
      expect(setup.renderer.root.findDescendantById("flower-graphics")).toBeUndefined();
      const capabilities = { ...setup.renderer.capabilities!, kitty_graphics: true, image_protocol: "kitty" as const };
      Object.defineProperty(setup.renderer, "capabilities", { configurable: true, get: () => capabilities });
      await act(async () => { setup.renderer.emit("capabilities", capabilities); });
      await setup.renderOnce();
      const graphic = setup.renderer.root.findDescendantById("flower-graphics") as ImageRenderable;
      expect(graphic).toBeInstanceOf(ImageRenderable);
      await graphic.loadPromise;
      const size = orbSize(60, 20);
      expect(graphic.width).toBe(size.width);
      expect(graphic.height).toBe(size.height);
      expect(graphic.image!.width).toBe(size.width * 8);
      expect(graphic.image!.height).toBe(size.height * 16);
      expect(graphic.loadError).toBeNull();
      // A failed graphics transport must leave a visible text flower.
      await act(async () => { graphic.onError?.(new Error("graphics unavailable")); });
      await setup.renderOnce();
      expect(setup.renderer.root.findDescendantById("flower-graphics")).toBeUndefined();
      expect(setup.captureCharFrame()).toMatch(/[░▒▓█]{3,}/);
    } finally {
      setup.renderer.destroy();
    }
  });

  test("renders the flower only, with no captions", async () => {
    const setup = await testRender(createElement(Orb, { width: 60, height: 20, animate: false }), { width: 60, height: 20, exitOnCtrlC: false });
    try {
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      for (const ch of frame.replaceAll("\n", "")) expect(GLYPH_RAMP).toContain(ch);
      expect(frame.trim().length).toBeGreaterThan(20);
      expect(frame).toMatch(/[░▒▓█]{3,}/);
    } finally {
      setup.renderer.destroy();
    }
  });
});

describe("flower graphics", () => {
  test("block bitmaps have the requested coverage and opaque backgrounds", () => {
    const raster = rasterizeFlower({ width: 6, height: 1, rows: [[{ text: " ·░▒▓█", color: "#ffffff" }]] });
    const counts = Array(6).fill(0);
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const i = (y * raster.width + x) * 4;
        if (raster.data[i] === 255) counts[Math.floor(x / 4)]++;
        expect(raster.data[i + 3]).toBe(255);
      }
    }
    expect(counts).toEqual([0, 4, 8, 16, 24, 32]);
  });

  test("samples four times as many glyphs instead of enlarging a low-resolution frame", () => {
    const raster = renderFlowerRaster(FULL, 21, 10, 42);
    expect(raster).toEqual(rasterizeFlower(renderOrb(FULL, 42, 20, 42)));
    expect(raster.width).toBe(168);
    expect(raster.height).toBe(160);
    expect(raster.data).not.toEqual(renderFlowerRaster(FULL + 1, 21, 10, 42).data);
  });
});
