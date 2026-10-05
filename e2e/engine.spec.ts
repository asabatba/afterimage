import { expect, test } from '@playwright/test';

test('gate 2: independent pitch and time, offline export', async ({ page }) => {
  page.on('console', (m) => console.log('[page]', m.text()));
  await page.goto('/e2e/harness.html');
  await page.waitForFunction(() => (window as any).ready);
  const r = await page.evaluate(() => (window as any).gate2());
  console.log(JSON.stringify(r));
  expect(r.plain.f).toBeCloseTo(440, 0);
  expect(r.plain.span.start).toBeLessThan(0.02);
  expect(r.plain.span.end).toBeCloseTo(4, 1);
  // +3 semitones: 523.25 Hz, still 4 s
  expect(Math.abs(r.up3.f - 523.25)).toBeLessThan(3);
  expect(r.up3.span.end - r.up3.span.start).toBeGreaterThan(3.85);
  expect(r.up3.span.end - r.up3.span.start).toBeLessThan(4.15);
  expect(r.up3.span.start).toBeLessThan(0.03);
  // stretched to 6 s at 440 Hz
  expect(Math.abs(r.stretch6.f - 440)).toBeLessThan(3);
  expect(r.stretch6.span.end - r.stretch6.span.start).toBeGreaterThan(5.85);
  expect(r.stretch6.span.end - r.stretch6.span.start).toBeLessThan(6.15);
  // repitch: 220 Hz for 8 s
  expect(Math.abs(r.repitch.f - 220)).toBeLessThan(2);
  expect(r.repitch.span.end).toBeCloseTo(8, 1);
  // onset alignment of a stretched clip at 2 s
  expect(Math.abs(r.offsetStart.span.start - 2)).toBeLessThan(0.03);
  // tracker note
  expect(Math.abs(r.tracker.f - 880)).toBeLessThan(4);
  expect(Math.abs(r.tracker.span.start - 1)).toBeLessThan(0.02);
  expect(Math.abs(r.tracker.span.end - 1.5)).toBeLessThan(0.05);
  // tail
  expect(r.tail.length).toBeCloseTo(7, 1);
  expect(r.tail.lateEnergy).toBeGreaterThan(0.001);
  expect(r.tail.lateEnergy).toBeLessThan(0.5);
});
