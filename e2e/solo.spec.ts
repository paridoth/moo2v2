import { test, expect } from '@playwright/test';

// Single player must work as a STANDALONE bundle: this spec runs against the
// production build (vite preview, port 4173) and aborts every request that
// leaves that origin — no lobbylink, no PBM server, no network at all. It
// plays turns against the bot, reloads, and resumes from OPFS persistence.

const APP = 'http://localhost:4173';

test('solo vs bot runs from the production bundle with zero network', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const external: string[] = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(APP)) return route.continue();
    external.push(url);
    return route.abort();
  });

  // --- start a solo campaign (fair bot: exercises the non-cheating AI) ---
  await page.goto(`${APP}/`);
  await page.getByTestId('name').fill('Solo');
  await page.getByTestId('bot-mode').selectOption('fair');
  await page.getByTestId('solo').click();

  // the bot readies itself in the in-process lobby; the human starts
  await expect(page.getByTestId('start')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('start').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });

  // persistent storage must be real (no memory-only fallback in the bundle)
  await expect(page.getByTestId('memory-only')).toHaveCount(0);

  // --- the bot commits on its own: human commits alone advance turns ---
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 2', { timeout: 20_000 });
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 3', { timeout: 20_000 });

  // --- save works in solo too, and waiting for it guarantees the async
  // persistence queue has flushed before we reload ---
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('save-game').click();
  await downloadPromise;
  await expect(page.getByTestId('save-note')).toContainText('saved', { timeout: 15_000 });

  // --- reload: the campaign resumes from the browser database ---
  await page.reload();
  await page.getByTestId('name').fill('Solo');
  await page.getByTestId('solo').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 3', { timeout: 30_000 });
  await expect(page.getByTestId('my-seat')).toContainText('Solo');

  // still fully playable after the resume
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 4', { timeout: 20_000 });

  // the whole session touched nothing outside the static origin
  expect(external).toEqual([]);

  await ctx.close();
});

// New solo-game controls: the room code names the campaign (so several bot
// games can run in different tabs), 🔄 restart abandons and re-lobbies, and
// bot games never show the red "everyone is waiting on you" screen edge.
test('room-coded campaigns, no red edge, restart, and two concurrent tabs', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && msg.text().includes('[session] persistence error:')) errors.push(msg.text()); });

  await page.goto(`${APP}/`);
  await page.getByTestId('name').fill('Resty');
  await page.getByTestId('room').fill('BOTA');
  await page.getByTestId('solo').click();
  await expect(page.getByTestId('start')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('start').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 2', { timeout: 20_000 });

  // the bot has already committed and we have not — in a solo game that must
  // NOT paint the red urgency edge or the "galaxy waits on you" wash
  await expect(page.locator('div.edge')).toHaveCount(0);
  await expect(page.getByTestId('all-waiting')).toHaveCount(0);

  // --- restart: abandons the turn-2 campaign, fresh lobby, fresh galaxy ---
  await page.getByTestId('restart-game').click();
  await expect(page.getByTestId('start')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('start').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });
  await page.getByTestId('commit').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 2', { timeout: 20_000 });

  // --- a second tab runs a DIFFERENT campaign at the same time: its own
  // room code means its own database — both persist, neither goes RAM-only
  const page2 = await ctx.newPage();
  await page2.goto(`${APP}/`);
  await page2.getByTestId('name').fill('Resty');
  await page2.getByTestId('room').fill('BOTB');
  await page2.getByTestId('solo').click();
  await expect(page2.getByTestId('start')).toBeEnabled({ timeout: 20_000 });
  await page2.getByTestId('start').click();
  await expect(page2.getByTestId('turn')).toHaveText('Turn 1', { timeout: 20_000 });
  await expect(page.getByTestId('memory-only')).toHaveCount(0);
  await expect(page2.getByTestId('memory-only')).toHaveCount(0);
  await page2.close();

  expect(errors).toEqual([]); // restart must flush before destroying its store

  // --- reload + re-enter BOTA: the RESTARTED campaign resumes (turn 2),
  // not the abandoned one ---
  await page.reload();
  await page.getByTestId('name').fill('Resty');
  await page.getByTestId('room').fill('BOTA');
  await page.getByTestId('solo').click();
  await expect(page.getByTestId('turn')).toHaveText('Turn 2', { timeout: 30_000 });
  expect(errors).toEqual([]);

  await ctx.close();
});
