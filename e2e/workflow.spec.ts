import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const files = ['chords-phrase.wav', 'drum-loop.wav', 'pluck-c4.wav', 'texture.wav'].map((f) => path.join(FIX, f));

async function freshApp(page: Page) {
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__afterimage);
  await page.waitForTimeout(500);
}

async function importAndPlace(page: Page) {
  await page.setInputFiles('.pool input[type=file]', files);
  await expect(page.locator('.pool-item.sample')).toHaveCount(4);
  const items = page.locator('.pool-item.sample');
  const lanes = page.locator('.lane');
  await items.nth(0).dragTo(lanes.nth(0), { targetPosition: { x: 2, y: 30 } });
  await items.nth(1).dragTo(lanes.nth(1), { targetPosition: { x: 2, y: 30 } });
  await expect(page.locator('.clip')).toHaveCount(2);
}

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__afterimage.project)));

test('gate 1: edit and loop a stereo phrase during playback', async ({ page }) => {
  await freshApp(page);
  await importAndPlace(page);
  // Loop the default range (bars 1–4).
  await page.keyboard.press('l');
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await page.waitForTimeout(600);
  // Trim the chords clip end while playing.
  const clip = page.locator('.lane').nth(0).locator('.clip');
  const box = (await clip.boundingBox())!;
  await page.mouse.move(box.x + box.width - 2, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 60, box.y + 30, { steps: 5 });
  await page.mouse.up();
  // Pitch it while playing.
  await clip.click({ position: { x: 40, y: 40 } });
  const semis = page.getByRole('spinbutton', { name: 'Semitones' });
  await semis.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(4500);
  const pos = await page.evaluate(() => (window as any).__afterimage.audio().engine.position());
  const s = await state(page);
  expect(s.loop.enabled).toBe(true);
  expect(pos).toBeGreaterThanOrEqual(s.loop.start);
  expect(pos).toBeLessThan(s.loop.end);
  expect(s.clips.find((c: any) => c.kind === 'audio' && c.semitones === 2)).toBeTruthy();
  expect(await page.evaluate(() => (window as any).__afterimage.audio().engine.playing)).toBe(true);
  await page.keyboard.press('Space');
});

test('loop wraps playback', async ({ page }) => {
  await freshApp(page);
  await importAndPlace(page);
  // Short loop: drag the default loop's end handle (beat 16) back to beat 4, then enable looping.
  const band = page.locator('.ruler-loop');
  const b = (await band.boundingBox())!;
  const ppb = await page.evaluate(() => (window as any).__afterimage.ui.pxPerBeat);
  await page.locator('.lane').nth(5).click({ position: { x: 40, y: 20 } });
  await page.mouse.move(b.x + 16 * ppb, b.y + 6);
  await page.mouse.down();
  await page.mouse.move(b.x + 4 * ppb, b.y + 6, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('l');
  const s = await state(page);
  expect(s.loop.enabled).toBe(true);
  expect(s.loop.end - s.loop.start).toBeCloseTo(4, 0);
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await page.waitForTimeout(3500); // 1.75 passes at 120 bpm
  const pos = await page.evaluate(() => (window as any).__afterimage.audio().engine.position());
  expect(pos).toBeLessThan(4.01);
  await page.keyboard.press('Space');
});

test('gate 3: sections, tracker, input recording and prints with correct routing', async ({ page }) => {
  await freshApp(page);
  await importAndPlace(page);
  // Three sections.
  const sections = page.locator('.ruler-sections');
  const ppb = await page.evaluate(() => (window as any).__afterimage.ui.pxPerBeat);
  for (const beat of [0, 8, 16]) await sections.dblclick({ position: { x: beat * ppb + 3, y: 8 } });
  expect((await state(page)).markers).toHaveLength(3);
  // Tracker part on track 3 using the pluck instrument.
  await page.locator('.pool-item.sample').nth(2).getByRole('button', { name: 'Instrument' }).click();
  await page.locator('.lane').nth(2).dblclick({ position: { x: 4, y: 30 } });
  await page.locator('.tracker-grid').focus();
  for (const k of ['z', 'c', 'b', 'q']) await page.keyboard.press(k);
  const st = await state(page);
  expect(st.patterns[0].cells.slice(0, 4).map((r: any) => r[0]?.note)).toEqual([60, 64, 67, 72]);

  // Open capture: print Track 4 (empty) over a fixed 2-bar range → silence, even with the click on.
  await page.getByRole('button', { name: 'Capture', exact: true }).click();
  const capture = page.locator('.capture');
  await page.getByRole('button', { name: 'Click', exact: true }).click();
  const trackIds = st.tracks.map((t: any) => t.id);
  await capture.getByLabel('Source', { exact: true }).selectOption(trackIds[3]);
  await capture.getByLabel('Destination', { exact: true }).selectOption(trackIds[5]);
  await capture.getByRole('radio', { name: 'Bars' }).click();
  await page.keyboard.press('Home');
  const countIn = capture.getByRole('spinbutton', { name: 'Count-in' });
  await countIn.focus();
  await page.keyboard.press('ArrowDown'); // no count-in
  await capture.getByRole('button', { name: 'Print' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Printed' })).toHaveCount(1, { timeout: 15000 });

  const analyse = (name: string) =>
    page.evaluate((n) => {
      const { project, samples } = (window as any).__afterimage;
      const meta = project.samples.filter((s: any) => s.name.startsWith(n)).at(-1);
      const s = samples.get(meta.id);
      const ch = s.buffer.getChannelData(0);
      let peak = 0, first = -1;
      for (let i = 0; i < ch.length; i++) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
        if (first < 0 && v > 0.05) first = i;
      }
      return { peak, first: first / s.buffer.sampleRate, channels: s.buffer.numberOfChannels, duration: s.buffer.duration, kind: meta.kind, capture: meta.capture, beats: meta.beats };
    }, name);

  const empty = await analyse('Print · Track 4');
  expect(empty.peak).toBeLessThan(1e-4); // metronome excluded, other tracks excluded
  expect(empty.duration).toBeCloseTo(8, 1); // 4 bars at 120 bpm
  expect(empty.kind).toBe('print');
  expect(empty.beats).toBe(16);

  // Print Track 2 (the drum loop starts exactly at beat 0) → onset aligned, stereo.
  await capture.getByLabel('Source', { exact: true }).selectOption(trackIds[1]);
  await page.keyboard.press('Home');
  await capture.getByRole('button', { name: 'Print' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Print · Track 2' })).toHaveCount(1, { timeout: 15000 });
  const drums = await analyse('Print · Track 2');
  expect(drums.peak).toBeGreaterThan(0.3);
  expect(drums.first).toBeLessThan(0.006);
  expect(drums.channels).toBe(2);
  expect(drums.capture.source).toBe('track');
  expect(drums.capture.clipIds.length).toBe(1);

  // Master print over the same range includes everything (louder than drums alone).
  await capture.getByLabel('Source', { exact: true }).selectOption('master');
  await page.keyboard.press('Home');
  await capture.getByRole('button', { name: 'Print' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Print · Master' })).toHaveCount(1, { timeout: 15000 });
  const master = await analyse('Print · Master');
  expect(master.peak).toBeGreaterThan(0.3);
  expect(master.capture.clipIds.length).toBeGreaterThanOrEqual(3);

  // Input recording from Chromium's fake device.
  await capture.getByLabel('Source', { exact: true }).selectOption('input');
  await capture.getByRole('button', { name: 'Enable input' }).click();
  await expect(capture.getByText(/Raw input|speech processing/)).toBeVisible({ timeout: 10000 });
  await capture.getByRole('radio', { name: 'Free' }).click();
  await capture.getByRole('button', { name: 'Record' }).click();
  await page.waitForTimeout(1500);
  await capture.getByRole('button', { name: 'Stop and keep' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Recorded' })).toHaveCount(1, { timeout: 15000 });
  const take = await analyse('Take');
  expect(take.kind).toBe('recording');
  expect(take.duration).toBeGreaterThan(0.8);

  // Cancel discards only the pending take.
  const before = (await state(page)).samples.length;
  await capture.getByRole('button', { name: 'Record' }).click();
  await page.waitForTimeout(500);
  await capture.getByRole('button', { name: 'Cancel take' }).click();
  await page.waitForTimeout(500);
  expect((await state(page)).samples.length).toBe(before);
});

test('gate 4: reopen captured audio and export a two-minute song', async ({ page }) => {
  await freshApp(page);
  await importAndPlace(page);
  // Build two minutes: loop the drum clip across 60 bars.
  const s0 = await state(page);
  const drumId = s0.clips.find((c: any) => c.trackId === s0.tracks[1].id).id;
  await page.locator(`[data-clip-id="${drumId}"]`).click({ position: { x: 20, y: 40 } });
  await page.getByRole('button', { name: 'Loop', exact: true }).last().click();
  const clip = page.locator(`[data-clip-id="${drumId}"]`);
  const box = (await clip.boundingBox())!;
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  await page.keyboard.press('-');
  const ppb = await page.evaluate(() => (window as any).__afterimage.ui.pxPerBeat);
  const b2 = (await clip.boundingBox())!;
  await page.mouse.move(b2.x + b2.width - 2, b2.y + 30);
  await page.mouse.down();
  await page.mouse.move(b2.x + 240 * ppb - 2, b2.y + 30, { steps: 10 });
  await page.mouse.up();
  void box;
  const s1 = await state(page);
  const looped = s1.clips.find((c: any) => c.id === drumId);
  expect(looped.loop).toBe(true);
  expect(looped.length).toBeCloseTo(240, 0);

  // Persisted: reload and the audio is still there.
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForFunction(() => (window as any).__afterimage);
  await expect(page.locator('.clip')).toHaveCount(2, { timeout: 10000 });
  const restored = await page.evaluate(() => {
    const { project, samples } = (window as any).__afterimage;
    return project.samples.every((s: any) => samples.has(s.id));
  });
  expect(restored).toBe(true);

  // Export through the dialog: whole song + 3 s tail.
  await page.locator('.menu-wrap > .ghost').click();
  await page.getByRole('menuitem', { name: 'Export WAV…' }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export WAV' }).click();
  const file = await dl;
  const p = await file.path();
  const fs = await import('node:fs');
  const bytes = fs.readFileSync(p!);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = v.getUint32(24, true);
  const channels = v.getUint16(22, true);
  const bits = v.getUint16(34, true);
  const dataBytes = bytes.byteLength - 44;
  const seconds = dataBytes / (sampleRate * channels * (bits / 8));
  expect(channels).toBe(2);
  expect(bits).toBe(24);
  expect(seconds).toBeGreaterThan(122.9); // 240 beats = 120 s + 3 s tail
  expect(seconds).toBeLessThan(123.1);
  // The kick at beat 236 (bar 60) lands on time in the export.
  const frame = Math.round(118 * sampleRate);
  const at = (f: number) => {
    const o = 44 + f * channels * 3;
    let x = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16);
    if (x & 0x800000) x -= 0x1000000;
    return Math.abs(x / 0x800000);
  };
  let first = -1;
  for (let f = frame - 2400; f < frame + 2400; f++) if (at(f) > 0.05) { first = f; break; }
  expect(Math.abs(first - frame) / sampleRate).toBeLessThan(0.003);
});
