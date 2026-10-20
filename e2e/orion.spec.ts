import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeSaveFile } from '../src/storage/savefile';
import type { GameState } from '../src/engine/types';

const APP = 'http://localhost:4173';

test('Orion: two fair opponents, human orders, automatic turns, OPFS reload and offline save-file restore', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const external: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    if (route.request().url().startsWith(APP)) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(APP);
  await page.getByTestId('name').fill('Orion Commander');
  await expect(page.getByTestId('bot-mode')).toHaveValue('strategic');
  await expect(page.locator('[data-testid^="bot-row-"]')).toHaveCount(2);
  await page.getByTestId('ai-difficulty').selectOption('normal');
  await page.getByTestId('solo').click();
  await expect(page.getByTestId('roster-count')).toHaveText('3 joined');
  await page.getByTestId('galaxy-size').selectOption('small');
  await page.getByTestId('race-select').selectOption('solari');
  await expect(page.getByTestId('start')).toBeEnabled();
  await page.getByTestId('start').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 1');
  await expect(page.getByTestId('memory-only')).toHaveCount(0);
  await page.locator('[data-testid^="build-"]').first().selectOption('housing');
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 2');
  await expect(page.getByTestId('turn-summary')).toContainText('Turn 2 ready');
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 3');
  const hash = await page.getByTestId('state-hash').textContent();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('save-game').click();
  const download = await downloadPromise;
  const path = join(mkdtempSync(join(tmpdir(), 'orion-save-')), download.suggestedFilename());
  await download.saveAs(path);
  await expect(page.getByTestId('save-note')).toContainText('saved');
  const envelope = await decodeSaveFile(new Uint8Array(readFileSync(path)));
  const saved = JSON.parse(envelope.snapshot!.stateJson) as GameState;
  expect(saved.settings.singlePlayer!.opponents.map((p) => p.strategy)).toEqual(['strategist-v3', 'strategist-v3']);

  // Deliberately choose the wrong opponent count/mode on reentry: ownership
  // and difficulty must come from the saved campaign, not the current form.
  await page.reload();
  await page.getByTestId('name').fill('Orion Commander');
  await page.getByTestId('bot-remove-1').click();
  await page.getByTestId('bot-mode').selectOption('parity');
  await page.getByTestId('solo').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 3');
  await expect(page.getByTestId('state-hash')).toHaveText(hash!);
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 4');

  // Importing a downloaded single-player save routes to offline hosting.
  await page.goto(APP);
  await page.getByTestId('name').fill('Orion Commander');
  await page.getByTestId('room').fill('ORION-IMPORT');
  await page.getByTestId('load-file').setInputFiles(path);
  await expect(page.getByTestId('save-preview')).toContainText('turn 3');
  await page.getByTestId('confirm-load').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 3');
  await expect(page.getByTestId('state-hash')).toHaveText(hash!);
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 4');
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
  await ctx.close();
});
