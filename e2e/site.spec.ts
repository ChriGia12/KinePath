// UI tests: the site as a user drives it, in a real browser (headless Chromium).
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/** ASCII STL of a box sx × sy × sz (mm). */
function boxStl(sx: number, sy: number, sz: number): Buffer {
  const v = (i: number) => [i & 1 ? sx : 0, i & 2 ? sy : 0, i & 4 ? sz : 0];
  const faces = [[0, 2, 3], [0, 3, 1], [4, 5, 7], [4, 7, 6], [0, 1, 5], [0, 5, 4], [2, 6, 7], [2, 7, 3], [0, 4, 6], [0, 6, 2], [1, 3, 7], [1, 7, 5]];
  let s = 'solid b\n';
  for (const f of faces) s += 'facet normal 0 0 0\nouter loop\n' + f.map((i) => `vertex ${v(i).join(' ')}`).join('\n') + '\nendloop\nendfacet\n';
  return Buffer.from(s + 'endsolid b\n');
}

/** ASCII STL of several boxes [x, y, z, sx, sy, sz] (mm) in one solid. */
function boxesStl(boxes: number[][]): Buffer {
  const faces = [[0, 2, 3], [0, 3, 1], [4, 5, 7], [4, 7, 6], [0, 1, 5], [0, 5, 4], [2, 6, 7], [2, 7, 3], [0, 4, 6], [0, 6, 2], [1, 3, 7], [1, 7, 5]];
  let s = 'solid b\n';
  for (const [x, y, z, sx, sy, sz] of boxes) {
    const v = (i: number) => [x + (i & 1 ? sx : 0), y + (i & 2 ? sy : 0), z + (i & 4 ? sz : 0)];
    for (const f of faces) s += 'facet normal 0 0 0\nouter loop\n' + f.map((i) => `vertex ${v(i).join(' ')}`).join('\n') + '\nendloop\nendfacet\n';
  }
  return Buffer.from(s + 'endsolid b\n');
}

const addPart = (page: Page, name: string, sx = 80, sy = 60, sz = 20) =>
  page.setInputFiles('#file', { name, mimeType: 'model/stl', buffer: boxStl(sx, sy, sz) });

/** A robot-settings or print-settings field by the start of its label. */
const field = (page: Page, label: string) => page.locator('#robotFields label, #printFields label').filter({ hasText: label }).first().locator('input, select');

const stat = (page: Page, label: string) => page.locator('.stat').filter({ hasText: label }).locator('.v');

async function setField(page: Page, label: string, value: string) {
  // Like a user: type, then leave the field (the browser fires "change" once).
  const f = field(page, label);
  await f.fill(value);
  await f.blur();
}

const download = (page: Page) => page.locator('#download');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
});

test('a part becomes a .src the robot can run', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  await expect(page.locator('#partList li')).toHaveCount(1);
  await expect(page.locator('#warnings li.blocked')).toHaveCount(0);
  const [dl] = await Promise.all([page.waitForEvent('download'), download(page).click()]);
  expect(dl.suggestedFilename()).toBe('blocco.src');
  const src = readFileSync((await dl.path())!, 'utf8');
  expect(src).toContain('$TOOL=TOOL_DATA[11]');
  expect(src).toContain('$BASE=BASE_DATA[1]');
  expect(src.match(/^LIN \{/gm)?.length).toBeGreaterThan(10);
  expect(src.trimEnd().endsWith('END')).toBe(true);
});

test('an empty number field blocks the download until it is fixed', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  await setField(page, 'Altezza strato', '');
  await expect(download(page)).toBeDisabled();
  await expect(page.locator('#exportState')).toContainText('inserisci un numero valido');
  await setField(page, 'Altezza strato', '2');
  await expect(download(page)).toBeEnabled();
});

test('a part off the table needs a confirmation, reset by any change', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  await page.locator('#step-robot summary').click();
  await setField(page, 'Centro X', '330');
  await expect(page.locator('#offBedRow')).toBeVisible();
  await expect(download(page)).toBeDisabled();
  await page.locator('#offBedOk').check();
  await expect(download(page)).toBeEnabled();
  await setField(page, 'Centro X', '331');
  await expect(page.locator('#offBedOk')).not.toBeChecked();
  await expect(download(page)).toBeDisabled();
});

test('the mandrino laid down near the plate is a collision that blocks the export', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  await page.locator('#step-robot summary').click();
  await setField(page, 'C (°)', '100');
  await expect(page.locator('#warnings')).toContainText('Collisione');
  await expect(download(page)).toBeDisabled();
  await setField(page, 'C (°)', '180');
  await expect(download(page)).toBeEnabled();
});

test('several parts are printed together; a part can be removed', async ({ page }) => {
  await addPart(page, 'primo.stl');
  await expect(download(page)).toBeEnabled();
  const one = await stat(page, 'Punti LIN').innerText();
  await addPart(page, 'secondo.stl', 40, 40, 20);
  await expect(page.locator('#partList li')).toHaveCount(2);
  await expect(download(page)).toBeEnabled();
  await expect(stat(page, 'Punti LIN')).not.toHaveText(one);
  const two = Number((await stat(page, 'Punti LIN').innerText()).replace(/\D/g, ''));
  expect(two).toBeGreaterThan(Number(one.replace(/\D/g, '')));
  await page.locator('#partList li').nth(1).getByRole('button', { name: 'Togli questo pezzo' }).click();
  await expect(page.locator('#partList li')).toHaveCount(1);
  await expect(download(page)).toBeEnabled();
  await expect(stat(page, 'Punti LIN')).toHaveText(one);
});

/** ASCII STL of an hourglass (wide – narrow – wide): not printable whole without supports. */
function hourglassStl(): Buffer {
  const prof = [[40, 0], [10, 30], [40, 60]];
  const seg = 48;
  const P = (i: number, j: number) => {
    const a = (j / seg) * Math.PI * 2;
    return [prof[i][0] * Math.cos(a), prof[i][0] * Math.sin(a), prof[i][1]];
  };
  const tris: number[][][] = [];
  for (let i = 0; i + 1 < prof.length; i++)
    for (let j = 0; j < seg; j++) {
      const k = (j + 1) % seg;
      tris.push([P(i, j), P(i, k), P(i + 1, k)], [P(i, j), P(i + 1, k), P(i + 1, j)]);
    }
  for (let j = 0; j < seg; j++) {
    const k = (j + 1) % seg;
    tris.push([[0, 0, 0], P(0, k), P(0, j)], [[0, 0, 60], P(2, j), P(2, k)]);
  }
  let s = 'solid h\n';
  for (const t of tris) s += 'facet normal 0 0 0\nouter loop\n' + t.map((v) => `vertex ${v.join(' ')}`).join('\n') + '\nendloop\nendfacet\n';
  return Buffer.from(s + 'endsolid h\n');
}

test('a part that cannot be printed whole: the site suggests the cut and applies it', async ({ page }) => {
  await page.setInputFiles('#file', { name: 'clessidra.stl', mimeType: 'model/stl', buffer: hourglassStl() });
  await expect(page.locator('#splitBox')).toBeVisible();
  await expect(page.locator('#splitText')).toContainText('I due pezzi si stampano senza supporti');
  await page.locator('#splitApply').click();
  await expect(page.locator('#partList li .title')).toHaveText(['1. clessidra.stl (1/2)', '2. clessidra.stl (2/2)']);
  await expect(page.locator('#splitBox')).toBeHidden();
  await expect(download(page)).toBeEnabled();
  await expect(page.locator('#warnings')).not.toContainText('senza supporti può crollare');
  await expect(page.locator('#modelInfo')).toContainText('watertight');
});

test('the cut section is always there: a manual horizontal cut gives two pieces', async ({ page }) => {
  await addPart(page, 'blocco.stl', 80, 60, 40);
  await expect(download(page)).toBeEnabled();
  await expect(page.locator('#cutBox')).toBeVisible();
  await expect(page.locator('#splitBox')).toBeHidden(); // a block needs no cut: no suggestion
  await page.locator('#cutAxis').selectOption('2');
  await page.locator('#cutMm').fill('15');
  await page.locator('#cutMm').blur();
  await page.locator('#cutApply').click();
  await expect(page.locator('#partList li .title')).toHaveText(['1. blocco.stl (1/2)', '2. blocco.stl (2/2)']);
  await expect(download(page)).toBeEnabled();
  await expect(page.locator('#modelInfo')).toContainText('80.0 × 60.0 × 15.0 mm');
  await page.locator('#partList li').nth(1).click();
  await expect(page.locator('#modelInfo')).toContainText('80.0 × 60.0 × 25.0 mm');
});

test('pieces that do not fit where they are are laid out on the table by themselves', async ({ page }) => {
  // A long bar across the table, cut along its length: the halves would overlap where they are.
  await addPart(page, 'barra.stl', 60, 500, 30);
  await expect(download(page)).toBeEnabled();
  await page.locator('#cutAxis').selectOption('0');
  await page.locator('#cutApply').click();
  await expect(page.locator('#partList li')).toHaveCount(2);
  await expect(download(page)).toBeEnabled();
  await expect(page.locator('#warnings')).not.toContainText('si sovrappongono');
  await expect(page.locator('#warnings')).not.toContainText('esce dal piano');
});

test('a part drawn in metres is flagged and scaled ×1000', async ({ page }) => {
  await addPart(page, 'metri.stl', 0.08, 0.06, 0.02);
  await expect(page.locator('#modelNotes')).toContainText('probabilmente il file è in metri');
  await page.locator('#scaleRow').getByRole('button', { name: '×1000' }).click();
  await expect(page.locator('#scaleInput')).toHaveValue('1000');
  await expect(page.locator('#modelInfo')).toContainText('80.0 × 60.0 × 20.0 mm');
  await expect(page.locator('#modelNotes')).not.toContainText('in metri');
  await expect(download(page)).toBeEnabled();
  await expect(stat(page, 'Estensione')).toContainText('X -35.0 … 45.0');
});

test('the printing order of the parts can be changed', async ({ page }) => {
  await addPart(page, 'primo.stl');
  await expect(download(page)).toBeEnabled();
  await addPart(page, 'secondo.stl', 40, 40, 20);
  await expect(download(page)).toBeEnabled();
  const firstLin = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), download(page).click()]);
    return readFileSync((await dl.path())!, 'utf8').match(/^PTP \{X[^}]*\}/m)![0];
  };
  const before = await firstLin();
  await expect(page.locator('#partList li .title')).toHaveText(['1. primo.stl', '2. secondo.stl']);
  await page.locator('#partList li').nth(1).getByRole('button', { name: /Stampa prima/ }).click();
  await expect(page.locator('#partList li .title')).toHaveText(['1. secondo.stl', '2. primo.stl']);
  await expect(download(page)).toBeEnabled();
  // the program now starts on the other part
  expect(await firstLin()).not.toBe(before);
});

test('a saved project opens again exactly as it was', async ({ page }) => {
  await addPart(page, 'primo.stl');
  await expect(download(page)).toBeEnabled();
  await addPart(page, 'secondo.stl', 40, 40, 20);
  await expect(page.locator('#partList li')).toHaveCount(2);
  await expect(download(page)).toBeEnabled();
  const before = await stat(page, 'Punti LIN').innerText();
  const extent = await stat(page, 'Estensione').innerText();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#saveProject').click()]);
  expect(dl.suggestedFilename()).toMatch(/\.kinepath$/);
  const project = readFileSync((await dl.path())!);

  await page.reload();
  await expect(page.locator('#partList li')).toHaveCount(0);
  await page.setInputFiles('#projectFile', { name: 'prova.kinepath', mimeType: 'application/json', buffer: project });
  await expect(page.locator('#partList li')).toHaveCount(2);
  await expect(download(page)).toBeEnabled();
  await expect(stat(page, 'Punti LIN')).toHaveText(before);
  await expect(stat(page, 'Estensione')).toHaveText(extent);
});

test('the PDF sheet lists the checks of the result', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  await page.evaluate(() => {
    const open = window.open.bind(window);
    window.open = (...a: Parameters<typeof window.open>) => {
      const w = open(...a);
      if (w) w.print = () => {};
      return w;
    };
  });
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('#reportBtn').click()]);
  await expect(popup.locator('h1')).toHaveText('blocco.src');
  await expect(popup.locator('.checks li')).toHaveCount(8);
  await expect(popup.locator('.checks li.bad')).toHaveCount(0);
});

test('the site switches to English and back', async ({ page }) => {
  await page.locator('#langToggle').click();
  await expect(page.locator('[data-i18n="step.model"]')).toHaveText('Model');
  await page.locator('#langToggle').click();
  await expect(page.locator('[data-i18n="step.model"]')).toHaveText('Modello');
});

test('the browser warning stays hidden when everything works', async ({ page }) => {
  await expect.poll(() => page.evaluate(() => (window as unknown as { kinepathStarted?: boolean }).kinepathStarted)).toBe(true);
  await page.waitForTimeout(9000);
  await expect(page.locator('#browserWarn')).toBeHidden();
});

test('supports in their own program: the simulation plays the real change of program', async ({ page }) => {
  // a 3D cross: whichever way it lies, two arms hang in the air and need supports
  const jack = boxesStl([
    [0, 25, 25, 60, 10, 10],
    [25, 0, 25, 10, 60, 10],
    [25, 25, 0, 10, 10, 60],
  ]);
  await page.setInputFiles('#file', { name: 'croce.stl', mimeType: 'model/stl', buffer: jack });
  await expect(download(page)).toBeVisible();
  await field(page, 'Supporti').selectOption('separate');
  await expect(page.locator('#downloadSup')).toBeVisible();
  // the first point of the part program, found by scrubbing the slider
  const k = await page.evaluate(() => {
    const slider = document.getElementById('simSlider') as HTMLInputElement;
    for (let i = 1; i <= +slider.max; i++) {
      slider.value = String(i);
      slider.dispatchEvent(new Event('input'));
      if (document.getElementById('simReadout')!.textContent!.includes('inizio programma del pezzo')) return i;
    }
    return -1;
  });
  expect(k).toBeGreaterThan(0);
  await page.evaluate((i) => {
    const slider = document.getElementById('simSlider') as HTMLInputElement;
    slider.value = String(i);
    slider.dispatchEvent(new Event('input'));
  }, k - 1);
  await page.locator('#simSpeed').selectOption('1');
  // every text the readout shows, in order
  await page.evaluate(() => {
    const el = document.getElementById('simReadout')!;
    const seen: string[] = ((window as unknown as { seen: string[] }).seen = []);
    new MutationObserver(() => seen.push(el.textContent!.split('\n')[0])).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('#playBtn').click();
  // until printing goes on after the start of the part program
  await page.waitForFunction(
    (i) => {
      const seen = (window as unknown as { seen: string[] }).seen;
      const start = seen.findIndex((l) => l.startsWith(`PTP ${i + 1} /`));
      return start >= 0 && seen.slice(start).some((l) => l.startsWith('LIN'));
    },
    k,
    { timeout: 20_000 },
  );
  const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
  const at = (text: string) => seen.findIndex((l) => l.includes(text));
  // last support point → safe position → homing → safe position → first point of the part
  expect(at('fine programma supporti')).toBeGreaterThanOrEqual(0);
  expect(at('homing tra i due programmi')).toBeGreaterThan(at('fine programma supporti'));
  expect(at(`PTP ${k + 1} /`)).toBeGreaterThan(at('homing tra i due programmi'));
});

test('a thin wall is printed along its middle, one pass per layer', async ({ page }) => {
  await addPart(page, 'parete.stl', 120, 6, 9);
  await expect(download(page)).toBeEnabled();
  await expect(page.locator('#warnings')).toContainText('Pareti sottili stampate sulla linea media');
  // one pass of 120 mm per layer instead of a loop around the wall (about 250 mm)
  const metres = parseFloat((await stat(page, 'Lunghezza stampa').innerText()).replace(',', '.'));
  expect(metres).toBeLessThan(0.9);
  await expect(page.locator('#printFields')).toContainText('Reticoli');
});

test('three print types; the contour is laid automatically or as chosen', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  const mode = field(page, 'Modo di stampa');
  await expect(mode.locator('option')).toHaveText([/^Contorno/, /^Riempimento/, /^Superficie/]);
  const strategy = field(page, 'Contorno: come stenderlo');
  await expect(strategy).toHaveValue('auto');
  await strategy.selectOption('spiral');
  await expect(stat(page, 'Modo scelto')).toContainText('Contorno a spirale');
  await strategy.selectOption('auto');
  await expect(stat(page, 'Modo scelto')).toContainText('Contorno a strati');
});

test('a stretch of the path can be changed by hand, and undone', async ({ page }) => {
  await addPart(page, 'blocco.stl');
  await expect(download(page)).toBeEnabled();
  const points = async () => parseInt((await stat(page, 'Punti LIN').innerText()).replace(/\D/g, ''), 10);
  const before = await points();
  await page.locator('#editToggle').click();
  await page.locator('#editFrom').fill('5');
  await page.locator('#editTo').fill('7');
  await page.locator('#editDelete').click();
  await expect(page.locator('#warnings')).toContainText('Percorso modificato a mano');
  await expect(page.locator('#editCount')).toContainText('1 modifiche');
  expect(await points()).toBe(before - 3);
  // the edited program is still checked: it can be downloaded only if the checks pass
  await expect(page.locator('#exportState li')).toHaveCount(0);
  await page.locator('#editUndo').click();
  await expect(page.locator('#warnings')).not.toContainText('Percorso modificato a mano');
  expect(await points()).toBe(before);
  // a change of settings discards the edits, and says so
  await page.locator('#editFrom').fill('5');
  await page.locator('#editTo').fill('5');
  await page.locator('#editOff').click();
  await expect(page.locator('#warnings')).toContainText('Percorso modificato a mano');
  await setField(page, 'Altezza strato', '2');
  await expect(page.locator('#warnings')).toContainText('le modifiche fatte a mano non valgono più');
});

test('a path made elsewhere (.src from Grasshopper) is placed, checked and written as a complete program', async ({ page }) => {
  // what KUKA|prc writes: world coordinates, its own A/B/C, no extruder, no safe position, no homing
  const lin = (x: number, y: number, z: number) => `LIN {X ${x}, Y ${y}, Z ${z}, A -167.186, B 0, C 180, E1 1050, E2 0, E3 0, E4 0} C_DIS`;
  const rows = ['DEF prova ( )', 'PTP $AXIS_ACT ; skip BCO quickly'];
  for (let k = 0; k < 3; k++) for (const [x, y] of [[-40, -40], [40, -40], [40, 40], [-40, 40], [-40, -40]]) rows.push(lin(1458 + x, -480 + y, 43.5 + k * 1.5));
  await page.setInputFiles('#file', { name: 'percorso.src', mimeType: 'text/plain', buffer: Buffer.from([...rows, 'END'].join('\r\n')) });
  await expect(download(page)).toBeEnabled();
  await expect(stat(page, 'Modo scelto')).toContainText('Percorso importato');
  await expect(page.locator('#modelNotes')).toContainText('Percorso già pronto: 15 punti LIN');
  await expect(page.locator('#cutBox')).toBeHidden();
  await expect(page.locator('#step-orient')).toBeHidden();
  const lins = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), download(page).click()]);
    const src = readFileSync((await dl.path())!, 'utf8');
    return { src, pts: src.split('\r\n').filter((l) => l.startsWith('LIN {')).map((l) => ['X', 'Y', 'Z'].map((a) => parseFloat(new RegExp(`${a} (-?[\\d.]+)`).exec(l)![1]))) };
  };
  // centred on the point of the plate (X 5, Y 515), first layer 0.5 mm above the plate at Z 38
  let r = await lins();
  expect(r.pts.length).toBe(15);
  expect(r.pts[0]).toEqual([5 - 40, 515 - 40, 38.5]);
  expect(r.src).toContain('A -180.000, B 0.000, C 180.000, E1 0.000');
  expect(r.src).toContain('ACCENSIONE ESTRUSORE');
  expect(r.src).toContain('; HOMING');
  // moved: the program is written again with the new coordinates
  await page.locator('#step-robot summary').click();
  await setField(page, 'Centro X in BASE', '60');
  await expect(download(page)).toBeEnabled();
  r = await lins();
  expect(r.pts[0]).toEqual([60 - 40, 515 - 40, 38.5]);
  // kept where the file has it: world → BASE, as the Python script did
  await field(page, 'Posizione del pezzo').selectOption('file');
  await expect(download(page)).toBeEnabled();
  r = await lins();
  expect(r.pts[0]).toEqual([1418 - 1448, -520 + 1000, 43.5 - 5]);
});

test('an imported path can be changed: start point, tool leaning; curves of a Rhino file are a path too', async ({ page }) => {
  // a cone drawn as curves in a Rhino file: closed rings, each 2 mm narrower and 1.5 mm higher
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rhino = (await ((await import('rhino3dm')).default as any)()) as any;
  const doc = new rhino.File3dm();
  for (let k = 0; k < 8; k++) {
    const pl = new rhino.Polyline();
    for (let i = 0; i <= 48; i++) pl.add((60 - 2 * k) * Math.cos((i / 48) * 2 * Math.PI), (60 - 2 * k) * Math.sin((i / 48) * 2 * Math.PI), 1 + 1.5 * k);
    doc.objects().addCurve(pl.toPolylineCurve(), null);
  }
  await page.setInputFiles('#file', { name: 'cono.3dm', mimeType: 'application/octet-stream', buffer: Buffer.from(doc.toByteArray()) });
  await expect(download(page)).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#modelNotes')).toContainText('8 curve del file Rhino');
  await expect(stat(page, 'Modo scelto')).toContainText('Percorso importato');
  const first = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), download(page).click()]);
    const src = readFileSync((await dl.path())!, 'utf8');
    const l = src.split('\r\n').filter((x) => x.startsWith('LIN {'));
    return { x: parseFloat(/X (-?[\d.]+)/.exec(l[0])![1]), y: parseFloat(/Y (-?[\d.]+)/.exec(l[0])![1]), cs: l.map((x) => parseFloat(/ C (-?[\d.]+)/.exec(x)![1])) };
  };
  // as drawn: every ring starts on +X of the centre (X 5, Y 515), tool vertical
  let r = await first();
  expect([r.x, r.y]).toEqual([65, 515]);
  expect(r.cs.every((c) => c === 180)).toBe(true);
  // start point moved to the +Y side: every ring starts there
  await field(page, 'Punto iniziale').selectOption('point');
  await setField(page, 'Inizio X in BASE', '5');
  await setField(page, 'Inizio Y in BASE', '600');
  await expect(page.locator('#warnings')).toContainText('8 giri chiusi del percorso ora partono dal punto scelto');
  r = await first();
  expect(r.x).toBeCloseTo(5, 1);
  expect(r.y).toBeCloseTo(575, 1);
  // tool leaning along the wall, read from the path (at 30° the nozzle would touch the plate on
  // the second layer, and the site would block the export: 20° clears it)
  await setField(page, 'Inclinazione massima', '20');
  await page.locator('#printFields label').filter({ hasText: 'Inclina l\'utensile lungo la parete' }).locator('input').check();
  await expect(page.locator('#warnings')).toContainText('la parete è ricavata dal percorso');
  // a cone leans along X too, where C cannot follow: the site asks to confirm, as for any path
  await expect(download(page)).toBeDisabled();
  await page.locator('#tiltOk').check();
  await expect(download(page)).toBeEnabled();
  r = await first();
  expect(Math.max(...r.cs.map((c) => Math.abs(c - 180)))).toBeGreaterThan(10);
});

