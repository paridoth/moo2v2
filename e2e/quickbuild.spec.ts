import { test, expect } from '@playwright/test';

// Map-view quick builds in a real browser: B arms the selected home star,
// an item hotkey queues at the best colony (pinned, with a status bar under
// the map), ✕ cancels it back to autobuild; the autopilot sliders show on the
// map; the research queue banner appears; E commits the turn from anywhere.

test('map hotkey builds, status bars, autopilot bar and research queue', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // autopilot pre-enabled: the map must carry the same slider bar
  await page.addInitScript(() => {
    localStorage.setItem(
      'moo2.autopilot',
      JSON.stringify({ enabled: true, weights: { infra: 6, pop: 5, research: 5, colonyShips: 4, military: 3 } }),
    );
  });

  await page.goto('/');
  await page.getByTestId('name').fill('Keys');
  await page.getByTestId('bot-mode').selectOption('fair');
  await page.getByTestId('solo').click();
  await expect(page.getByTestId('start')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('start').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });

  // --- map: select the home star (id via the dev session hook) ---
  await page.getByTestId('tab-map').click();
  await expect(page.getByTestId('autopilot-bar')).toBeVisible(); // sliders on the map
  const homeStarId = await page.evaluate(() => {
    const w = window as unknown as { __moo2: { session: { getPlanned(): unknown; playerId: number } } };
    const s = w.__moo2.session.getPlanned() as {
      colonies: Array<{ owner: number; outpost: boolean; planetId: number }>;
      planets: Array<{ id: number; starId: number }>;
    };
    const home = s.colonies.find((c) => c.owner === w.__moo2.session.playerId && !c.outpost)!;
    return s.planets.find((p) => p.id === home.planetId)!.starId;
  });
  await page.getByTestId(`star-${homeStarId}`).click();
  await expect(page.getByTestId('selected-star')).toBeVisible();

  // --- B arms build mode, H queues housing (pinned) ---
  await page.keyboard.press('b');
  await expect(page.getByTestId('build-arm')).toBeVisible();
  await page.keyboard.press('h');
  await expect(page.getByTestId('map-note')).toContainText('queued at');
  await expect(page.getByTestId('pinned-builds')).toBeVisible();

  // a second item by hotkey: F = frigate from the latest auto design
  await page.keyboard.press('f');
  await expect(page.getByTestId('pinned-builds').locator('.pin')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('build-arm')).toHaveCount(0);

  // --- cancel the frigate: its bar disappears, housing stays pinned ---
  await page.getByTestId('pinned-builds').locator('.pcancel').last().click();
  await expect(page.getByTestId('pinned-builds').locator('.pin')).toHaveCount(1);

  // --- research queue: with idle labs the FIRST queued field starts on the
  // spot (auto-dequeue), so start one field, then queue a second — the
  // banner lists the waiting one ---
  await page.getByTestId('tab-research').click();
  await page.locator('button.primary[data-testid^="research-"]').first().click();
  await expect(page.getByTestId('researching')).not.toContainText('no research');
  await page.locator('[data-testid^="queue-research-"]').first().click();
  await expect(page.getByTestId('research-queue')).toBeVisible();

  // --- E ends the turn from the keyboard (bot has already committed) ---
  await page.keyboard.press('e');
  await expect(page.getByTestId('turn')).toHaveText('Turn 2', { timeout: 20_000 });

  // the pinned housing bar survived the turn and still shows progress
  await page.getByTestId('tab-map').click();
  await expect(page.getByTestId('pinned-builds').locator('.pin')).toHaveCount(1);

  // --- ⏩ fast-forward: auto-plays turns until an interrupt (or Shift+E).
  // It either sails past turn 4 or legitimately stops early (leader offer,
  // arrival…) with a named reason — both are correct behavior. ---
  await page.getByTestId('fast-forward').click();
  // A leader/arrival interrupt can stop auto-play in the same render.
  await expect(page.getByTestId('ff-banner').or(page.getByTestId('ff-note'))).toBeVisible();
  await expect
    .poll(
      async () => {
        const t = Number((await page.getByTestId('turn').textContent())?.replace(/\D/g, '') ?? '0');
        return t > 4 || (await page.getByTestId('ff-note').count()) > 0;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  if (await page.getByTestId('ff-banner').count()) await page.keyboard.press('Shift+E');
  await expect(page.getByTestId('ff-banner')).toHaveCount(0);

  await ctx.close();
});
