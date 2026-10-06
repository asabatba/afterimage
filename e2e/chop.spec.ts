import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';

const FIX = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = (f: string) => path.join(FIX, f);

const SR = 22050;
const BPM = 112;
const OFFSET = 0.37;
const BARS = 8;

/** A little "song": drums, a bass line and a C–F–Am–G progression (changing every two bars), 112 bpm, 0.37 s lead-in. */
function makeSong(): Buffer {
  const beat = 60 / BPM;
  const n = Math.floor((OFFSET + BARS * 4 * beat + 1) * SR);
  const L = new Float32Array(n),
    R = new Float32Array(n);
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  const add = (t: number, len: number, fn: (s: number) => number, pan = 0) => {
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < len * SR && s0 + i < n; i++) {
      const v = fn(i / SR);
      L[s0 + i] += v * (1 - Math.max(0, pan));
      R[s0 + i] += v * (1 + Math.min(0, pan));
    }
  };
  const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
  const chords = [
    [60, 64, 67],
    [53, 57, 60],
    [57, 60, 64],
    [55, 59, 62],
  ];
  const roots = [36, 41, 33, 31];
  for (let bar = 0; bar < BARS; bar++) {
    const t0 = OFFSET + bar * 4 * beat;
    const ci = Math.floor(bar / 2) % 4;
    for (const m of chords[ci]) {
      const f = hz(m);
      add(
        t0,
        4 * beat,
        (s) => 0.07 * (Math.sin(2 * Math.PI * f * s) + 0.5 * Math.sin(4 * Math.PI * f * s)) * Math.min(1, s * 40) * Math.min(1, (4 * beat - s) * 20),
        m % 2 ? 0.3 : -0.3,
      );
    }
    for (let b = 0; b < 4; b++) {
      const t = t0 + b * beat;
      add(t, 0.2, (s) => 0.8 * Math.sin(2 * Math.PI * (50 + 100 * Math.exp(-s * 45)) * s) * Math.exp(-s * 14));
      if (b % 2 === 1) add(t, 0.15, (s) => 0.35 * rnd() * Math.exp(-s * 28));
      add(t + beat / 2, 0.05, (s) => 0.12 * rnd() * Math.exp(-s * 90), 0.4);
      add(t, beat * 0.9, (s) => 0.22 * Math.sin(2 * Math.PI * hz(roots[ci]) * s) * Math.exp(-s * 3));
    }
  }
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(L[i] * 26000))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(R[i] * 26000))), 46 + i * 4);
  }
  return buf;
}

async function freshApp(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__afterimage);
  await page.waitForTimeout(400);
  return errors;
}

const state = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__afterimage.project)));
const uiState = (page: Page) => page.evaluate(() => JSON.parse(JSON.stringify((window as any).__afterimage.ui)));
const audioClips = async (page: Page) => (await state(page)).clips.filter((c: any) => c.kind === 'audio').sort((a: any, b: any) => a.start - b.start);

async function importSong(page: Page) {
  await page.setInputFiles('.pool input[type=file]', { name: 'song.wav', mimeType: 'audio/wav', buffer: makeSong() });
  await expect(page.locator('.chop')).toBeVisible();
  await expect.poll(async () => (await state(page)).samples[0]?.grid?.bpm ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
}

/** Select the grid cell under a point of the waveform. */
async function selectCell(page: Page, x: number, size: '4' | '1' = '4') {
  await page.getByLabel('Grid size').selectOption(size);
  await page.locator('.chop-wave').dblclick({ position: { x, y: 60 } });
}

test('a song opens in the sample editor with its tempo, beats and chords found', async ({ page }) => {
  const errors = await freshApp(page);
  await importSong(page);
  const s = await state(page);
  const grid = s.samples[0].grid;
  expect(Math.abs(grid.bpm - BPM)).toBeLessThan(0.5);
  // The bar start is right too, not just the beat: it follows the chord changes.
  const bar = (60 / BPM) * 4;
  const err = ((((grid.offset - OFFSET) % bar) + bar * 1.5) % bar) - bar / 2;
  expect(Math.abs(err)).toBeLessThan(0.02);
  await expect(page.locator('.pool-kind.grid')).toContainText('112');

  // Chord strip follows the progression.
  await expect.poll(async () => (await page.locator('.chop-chords .chord').allTextContents()).join(' ')).toMatch(/C.*F.*Am.*G/);
  // Hits were found and counted.
  const found = await page.locator('.chop-side .slider-value').first().textContent();
  expect(parseInt(found ?? '0', 10)).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test('zooming narrows the overview window and Fit restores it', async ({ page }) => {
  await freshApp(page);
  await importSong(page);
  const vp = page.locator('.chop-viewport');
  const full = (await vp.boundingBox())!.width;
  // A freshly opened sample is fitted even though the panel settles to its final width after mounting.
  expect(full).toBeGreaterThan((await page.locator('.chop-overview').boundingBox())!.width * 0.95);
  await page.locator('.chop').getByRole('button', { name: 'Zoom in' }).click();
  await page.locator('.chop').getByRole('button', { name: 'Zoom in' }).click();
  const zoomed = (await vp.boundingBox())!.width;
  expect(zoomed).toBeLessThan(full * 0.6);
  // Ctrl+wheel zooms around the pointer.
  const wave = page.locator('.chop-wave');
  const box = (await wave.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 50);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  expect((await vp.boundingBox())!.width).toBeLessThan(zoomed);
  await page.locator('.chop').getByRole('button', { name: 'Fit', exact: true }).click();
  expect((await vp.boundingBox())!.width).toBeGreaterThan(full * 0.95);
});

test('a bar is selected, previewed and placed on the timeline in tempo, then the song is sliced into bars', async ({ page }) => {
  const errors = await freshApp(page);
  await importSong(page);
  await selectCell(page, 260);
  await expect(page.locator('.insp-readout')).toContainText('1.00 bars');

  // Preview starts and stops.
  await page.locator('.chop').getByRole('button', { name: /Play/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__afterimage.audio().engine.auditionPosition())).not.toBeNull();
  await page.locator('.chop').getByRole('button', { name: /Stop/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__afterimage.audio().engine.auditionPosition())).toBeNull();

  await page.getByRole('button', { name: 'Add to timeline' }).click();
  let clips = await audioClips(page);
  expect(clips.length).toBe(1);
  const beat = 60 / BPM;
  expect(clips[0].timing).toBe('tempo');
  expect(Math.abs(clips[0].sourceBpm - (await state(page)).samples[0].grid.bpm)).toBeLessThan(1e-6);
  expect(clips[0].length).toBeCloseTo(4, 1);
  expect(clips[0].srcEnd - clips[0].srcStart).toBeCloseTo(4 * beat, 1);
  // The cursor moved to the end so the next piece follows.
  expect((await uiState(page)).cursor).toBeCloseTo(clips[0].start + clips[0].length, 3);

  // Slice the whole song into bars from the cursor.
  await page.locator('.chop').press('Escape');
  await page.getByLabel('Slice size').selectOption('bar');
  const btn = page.getByRole('button', { name: /Slice → timeline/ });
  await expect(btn).toContainText('(');
  const n = parseInt(/\((\d+)\)/.exec((await btn.textContent()) ?? '')![1], 10);
  expect(n).toBeGreaterThanOrEqual(BARS - 1);
  await btn.click();
  clips = await audioClips(page);
  expect(clips.length).toBe(1 + n);
  const slices = clips.slice(1);
  for (let i = 1; i < slices.length; i++) expect(slices[i].start).toBeCloseTo(slices[i - 1].start + slices[i - 1].length, 6);
  slices.slice(0, -1).forEach((c: any) => expect(c.length).toBeCloseTo(4, 1));
  expect(errors).toEqual([]);

  // Undo takes the whole slice back in one step.
  await page.locator('body').press('Control+z');
  expect((await audioClips(page)).length).toBe(1);
});

test('dragging selects a range that snaps to the beat grid, and its edges can be resized', async ({ page }) => {
  await freshApp(page);
  await importSong(page);
  await page.getByLabel('Grid size').selectOption('1');
  const wave = page.locator('.chop-wave');
  const box = (await wave.boundingBox())!;
  const grid = (await state(page)).samples[0].grid;
  const beat = 60 / grid.bpm;
  const readout = page.locator('.insp-readout').first();
  const range = async () => {
    const m = /Selection ([\d.]+)–([\d.]+) s/.exec((await readout.textContent()) ?? '');
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  };
  const onGrid = (t: number) => {
    const k = (t - grid.offset) / beat;
    return Math.abs(k - Math.round(k)) < 0.002;
  };

  const W = box.width;
  await page.mouse.move(box.x + W * 0.15, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + W * 0.45, box.y + 60, { steps: 6 });
  await page.mouse.up();
  const [a, b] = (await range())!;
  expect(b - a).toBeGreaterThan(beat * 3);
  expect(onGrid(a) && onGrid(b)).toBe(true);

  // Drag the right edge further out: it follows the pointer and stays on the grid.
  const sel = page.locator('.chop-sel');
  const sb = (await sel.boundingBox())!;
  await page.mouse.move(sb.x + sb.width, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width + W * 0.12, box.y + 60, { steps: 5 });
  await page.mouse.up();
  const [a2, b2] = (await range())!;
  expect(a2).toBeCloseTo(a, 6);
  expect(b2).toBeGreaterThan(b);
  expect(onGrid(b2)).toBe(true);

  // Alt turns snapping off.
  await page.keyboard.down('Alt');
  await page.mouse.move(box.x + W * 0.7, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + W * 0.7 + 37, box.y + 60, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  const [a3, b3] = (await range())!;

  expect(onGrid(a3) && onGrid(b3)).toBe(false);
});

test('Shift+Enter places the selection and steps to the next bar; a chord can be selected by clicking it', async ({ page }) => {
  await freshApp(page);
  await importSong(page);
  await selectCell(page, 200);
  const first = await page.locator('.insp-readout').first().textContent();
  await page.locator('.chop').press('Shift+Enter');
  await page.locator('.chop').press('Shift+Enter');
  const clips = await audioClips(page);
  expect(clips.length).toBe(2);
  expect(clips[1].start).toBeCloseTo(clips[0].start + clips[0].length, 6);
  expect(clips[1].srcStart).toBeCloseTo(clips[0].srcEnd, 3);
  expect(await page.locator('.insp-readout').first().textContent()).not.toBe(first);
  // The editor is still open.
  await expect(page.locator('.chop')).toBeVisible();

  await page.locator('.chop-chords .chord').nth(1).click();
  await expect(page.locator('.insp-readout').first()).toContainText('Selection');
  await expect(page.locator('.chop-side .chip').last()).toContainText('F');
});

test('a selected region can be dragged onto a lane', async ({ page }) => {
  await freshApp(page);
  await importSong(page);
  await selectCell(page, 260);
  await page.locator('.chop-drag').dragTo(page.locator('.lane').nth(2), { targetPosition: { x: 120, y: 30 } });
  const clips = await audioClips(page);
  expect(clips.length).toBe(1);
  const s = await state(page);
  expect(clips[0].trackId).toBe(s.tracks[2].id);
  expect(clips[0].srcEnd - clips[0].srcStart).toBeCloseTo(4 * (60 / BPM), 1);
});

test('the grid can be corrected by hand and the pool shows it', async ({ page }) => {
  await freshApp(page);
  await importSong(page);
  const before = (await state(page)).samples[0].grid;
  await page.getByRole('button', { name: '×2' }).click();
  expect((await state(page)).samples[0].grid.bpm).toBeCloseTo(before.bpm * 2, 2);
  await page.getByRole('button', { name: '÷2' }).click();
  expect((await state(page)).samples[0].grid.bpm).toBeCloseTo(before.bpm, 2);
  await page.getByRole('button', { name: 'Downbeat +1' }).click();
  expect((await state(page)).samples[0].grid.offset).toBeCloseTo(before.offset + 60 / before.bpm, 3);
  await page.getByRole('button', { name: 'Use as project tempo' }).click();
  expect((await state(page)).bpm).toBeCloseTo(before.bpm, 1);
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  expect((await state(page)).samples[0].grid.offset).toBeCloseTo(before.offset, 3);
});

test('tapping along to the preview sets the tempo and the beat positions in one undoable step', async ({ page }) => {
  await freshApp(page);
  await importSong(page);
  const detected = (await state(page)).samples[0].grid;
  // Break the grid, then repair it by tapping.
  await page.getByRole('button', { name: '×2' }).click();
  expect((await state(page)).samples[0].grid.bpm).toBeCloseTo(detected.bpm * 2, 2);

  await page.locator('.chop').getByRole('button', { name: /Play/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__afterimage.audio().engine.auditionPosition())).not.toBeNull();
  // A tapper that presses T as the playhead crosses each true beat, starting on the second bar's downbeat.
  await page.evaluate(
    ({ offset, beat }) => {
      const el = document.querySelector('.chop') as HTMLElement;
      const engine = (window as any).__afterimage.audio().engine;
      let k = 4;
      const last = k + 15;
      const step = () => {
        const pos = engine.auditionPosition();
        if (pos !== null && pos >= offset + k * beat) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
          k++;
        }
        if (k <= last) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    { offset: OFFSET, beat: 60 / BPM },
  );
  await expect(page.locator('.chop-tap')).toContainText(/\d+ taps/);
  // Tapping stops: the grid is applied.
  await expect.poll(async () => (await state(page)).samples[0].grid.bpm, { timeout: 20_000 }).toBeLessThan(detected.bpm * 1.5);
  const g = (await state(page)).samples[0].grid;
  expect(Math.abs(g.bpm - BPM)).toBeLessThan(0.3);
  const bar = (60 / BPM) * 4;
  const err = ((((g.offset - OFFSET) % bar) + bar * 1.5) % bar) - bar / 2;
  expect(Math.abs(err)).toBeLessThan(0.02);
  await page.locator('.chop').getByRole('button', { name: /Stop/ }).click();

  // One undo takes the whole tap session back.
  await page.locator('body').press('Control+z');
  expect((await state(page)).samples[0].grid.bpm).toBeCloseTo(detected.bpm * 2, 2);
});

test('tap tempo without playback sets only the tempo', async ({ page }) => {
  await freshApp(page);
  await importSong(page);
  const before = (await state(page)).samples[0].grid;
  const tapButton = page.locator('.chop').getByRole('button', { name: 'Tap', exact: true });
  for (let i = 0; i < 7; i++) {
    await tapButton.dispatchEvent('pointerdown', { button: 0 });
    if (i === 1) await expect(page.locator('.chop-tap')).toContainText('2 taps');
    await page.waitForTimeout(500);
  }
  await expect.poll(async () => Math.abs((await state(page)).samples[0].grid.bpm - 120), { timeout: 20_000 }).toBeLessThan(5);
  const after = (await state(page)).samples[0].grid;
  expect(after.offset).toBeCloseTo(before.offset, 6);
});

test('a pitched sample becomes a tuned instrument; clips report note and chord', async ({ page }) => {
  await freshApp(page);
  await page.setInputFiles('.pool input[type=file]', fixture('pluck-c4.wav'));
  await expect(page.locator('.chop')).toBeVisible();
  await page.getByRole('button', { name: 'Make instrument' }).click();
  await expect.poll(async () => (await state(page)).instruments.length).toBe(1);
  const ins = (await state(page)).instruments[0];
  expect(ins.rootNote).toBe(60);
  expect(Math.abs(ins.fineTune)).toBeLessThanOrEqual(30);

  // Place the sample and ask the clip inspector what it hears.
  await page
    .locator('.pool-item.sample')
    .first()
    .dragTo(page.locator('.lane').nth(0), { targetPosition: { x: 4, y: 30 } });
  await page
    .locator('.clip')
    .first()
    .click({ position: { x: 20, y: 30 } });
  await page.getByRole('button', { name: 'Note & chord' }).click();
  await expect(page.locator('.insp-controls .chip').first()).toContainText('C-4');
});

test.describe('arrangement: copy, paste, repeat and fill', () => {
  async function placeLoop(page: Page) {
    await page.setInputFiles('.pool input[type=file]', fixture('drum-loop.wav'));
    await expect(page.locator('.pool-item.sample')).toHaveCount(1);
    await page
      .locator('.pool-item.sample')
      .first()
      .dragTo(page.locator('.lane').nth(0), { targetPosition: { x: 2, y: 30 } });
    await expect(page.locator('.clip')).toHaveCount(1);
    return (await audioClips(page))[0];
  }

  test('repeat adds copies end to end and undoes in one step', async ({ page }) => {
    await freshApp(page);
    const c = await placeLoop(page);
    await expect(page.getByRole('button', { name: 'Repeat ×' })).toBeEnabled();
    await page.getByRole('button', { name: 'Repeat ×' }).click();
    const clips = await audioClips(page);
    expect(clips.length).toBe(5);
    clips.forEach((x: any, i: number) => expect(x.start).toBeCloseTo(c.start + i * c.length, 5));
    await page.locator('body').press('Control+z');
    expect((await audioClips(page)).length).toBe(1);
  });

  test('fill stops at the loop end with a trimmed last copy', async ({ page }) => {
    await freshApp(page);
    const c = await placeLoop(page);
    const loopEnd = (await state(page)).loop.end;
    test.skip(c.length >= loopEnd, 'fixture is longer than the loop range');
    await page.getByLabel('Fill target').selectOption('loop');
    await page.getByRole('button', { name: 'Fill to' }).click();
    const clips = await audioClips(page);
    expect(clips.length).toBeGreaterThan(1);
    const last = clips[clips.length - 1];
    expect(last.start + last.length).toBeLessThanOrEqual(loopEnd + 1e-6);
    expect(last.start + last.length).toBeCloseTo(loopEnd, 3);
  });

  test('copy and paste continue where the last paste ended, on the clicked track', async ({ page }) => {
    await freshApp(page);
    const c = await placeLoop(page);
    await page
      .locator('.clip')
      .first()
      .click({ position: { x: 20, y: 30 } });
    await page.keyboard.press('Control+c');
    // Click an empty stretch of track 2, past the clip, to set the cursor and the active track.
    const lane = page.locator('.lane').nth(1);
    const ppb = (await uiState(page)).pxPerBeat;
    await lane.click({ position: { x: 20 * ppb, y: 30 } });
    await page.keyboard.press('Control+v');
    await page.keyboard.press('Control+v');
    const s = await state(page);
    const clips = await audioClips(page);
    expect(clips.length).toBe(3);
    const pasted = clips.filter((x: any) => x.trackId === s.tracks[1].id);
    expect(pasted.length).toBe(2);
    expect(pasted[0].start).toBeCloseTo(20, 0);
    expect(pasted[1].start).toBeCloseTo(pasted[0].start + c.length, 5);
    // Cut removes and pastes elsewhere.
    await page
      .locator('.clip')
      .first()
      .click({ position: { x: 20, y: 30 } });
    await page.keyboard.press('Control+x');
    expect((await audioClips(page)).length).toBe(2);
  });

  test('Fit and Z zoom the arrangement to the song or the selected clips', async ({ page }) => {
    await freshApp(page);
    await placeLoop(page);
    const before = (await uiState(page)).pxPerBeat;
    await page.getByRole('button', { name: 'Fit', exact: true }).first().click();
    const fitted = (await uiState(page)).pxPerBeat;
    expect(fitted).toBeGreaterThan(before);
    await page.getByRole('button', { name: 'Zoom out' }).first().click();
    expect((await uiState(page)).pxPerBeat).toBeLessThan(fitted);
    // Z with a clip selected zooms to it; with nothing selected it fits the song.
    await page
      .locator('.clip')
      .first()
      .click({ position: { x: 20, y: 30 } });
    await page.keyboard.press('z');
    const toClip = (await uiState(page)).pxPerBeat;
    expect(toClip).toBeGreaterThan(before);
    await page.keyboard.press('Escape');
    await page.keyboard.press('z');
    expect((await uiState(page)).pxPerBeat).toBeCloseTo(fitted, 0);
    expect(toClip).toBeGreaterThan(fitted);
  });

  test('dragging the corner handle repeats the clip', async ({ page }) => {
    await freshApp(page);
    const c = await placeLoop(page);
    await page
      .locator('.clip')
      .first()
      .click({ position: { x: 20, y: 30 } });
    const handle = page.locator('.fill-handle');
    await expect(handle).toBeVisible();
    const hb = (await handle.boundingBox())!;
    const ppb = (await uiState(page)).pxPerBeat;
    const x0 = hb.x + hb.width / 2,
      y0 = hb.y + hb.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + c.length * ppb * 2.6, y0, { steps: 8 });
    await page.mouse.up();
    const clips = await audioClips(page);
    expect(clips.length).toBe(4); // the original and three copies
    expect(clips[3].start).toBeCloseTo(c.start + 3 * c.length, 5);
  });
});
