<script lang="ts">
  import { RACE_PRESETS } from '@engine/data/index';
  import { SHIP_STYLES } from '@engine/shipstyles';
  import { BOT_RACES } from '../botRaces';
  import { PLAYER_COLORS } from '../colors';
  import { DEFAULT_SERVER, enterRoom, enterSoloGame, type SoloBotSpec } from '../net';
  import { enterPbmGame, pbmToken } from '../pbm';
  import { describeSaveError, importSaveIntoRoom, previewSave, type SavePreview } from '../saveload';
  import { app, bindActive } from '../state.svelte';

  const q = new URLSearchParams(location.search);
  let server = $state(q.get('server') ?? DEFAULT_SERVER);
  let code = $state(q.get('room') ?? '');
  let name = $state(q.get('name') ?? '');
  let playerCount = $state(Number(q.get('players') ?? '2'));
  let loadNote = $state('');
  let fileInput: HTMLInputElement;

  async function go() {
    if (!code || !name) {
      app.error = 'name and room code are required';
      return;
    }
    app.error = '';
    app.connecting = true;
    try {
      const active = await enterRoom({ server, code, name, playerCount, debug: q.get('debug') === '1' });
      bindActive(active);
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
    } finally {
      app.connecting = false;
    }
  }

  let botMode = $state<'strategic' | 'parity' | 'fair' | 'onion'>('strategic');
  let difficulty = $state<'easy' | 'normal'>('normal');

  // per-bot scenario config: play style, race (archetype or stock preset),
  // fleet silhouette and banner color — 'auto' keeps the seat defaults
  interface BotRow {
    personality: 'auto' | 'techer' | 'rusher' | 'industrialist' | 'expander' | 'militarist';
    race: string; // archetype/preset id, or 'auto' (hivex)
    shipStyle: string; // style id or 'auto'
    color: string; // #rrggbb or 'auto'
  }
  const COLOR_NAMES = ['blue', 'red', 'green', 'yellow', 'purple', 'cyan', 'orange', 'pink'];
  const defaultBot = (): BotRow => ({ personality: 'militarist', race: 'forgers', shipStyle: 'auto', color: 'auto' });
  let botRows = $state<BotRow[]>([defaultBot(), { ...defaultBot(), personality: 'expander', race: 'hivex' }]);

  async function goSolo() {
    if (!name) {
      app.error = 'enter a name first';
      return;
    }
    app.error = '';
    app.connecting = true;
    try {
      const specs: SoloBotSpec[] = botRows.map((r) => ({
        personality: r.personality,
        ...(r.race !== 'auto' ? { race: r.race } : {}),
        ...(r.shipStyle !== 'auto' ? { shipStyle: r.shipStyle } : {}),
        ...(r.color !== 'auto' ? { color: r.color } : {}),
      }));
      // the room code differentiates bot campaigns (blank = the classic SOLO
      // room), so several single-player games can run in different tabs
      const active = await enterSoloGame(name, botMode, specs[0]?.personality ?? 'militarist', specs, { code, difficulty });
      bindActive(active);
    } catch (e) {
      app.error = e instanceof Error ? e.message : String(e);
    } finally {
      app.connecting = false;
    }
  }

  let preview = $state<SavePreview | null>(null);
  let resumeTurn = $state<number | 'latest'>('latest');

  // ---- play by mail ----
  let pbmPassword = $state('');
  let pbmSeatPassword = $state('');
  const pbmLoggedIn = $derived(server ? pbmToken(server) !== null : false);

  async function goPbm() {
    if (!code || !name) {
      app.error = 'name and room code are required';
      return;
    }
    if (!pbmLoggedIn && !pbmPassword) {
      app.error = 'enter the shared play-by-mail password once to log in';
      return;
    }
    app.error = '';
    app.connecting = true;
    try {
      const active = await enterPbmGame({
        server,
        code,
        name,
        ...(pbmPassword ? { password: pbmPassword } : {}),
        ...(pbmSeatPassword ? { playerPassword: pbmSeatPassword } : {}),
        createFrom: preview,
      });
      preview = null;
      pbmPassword = '';
      bindActive(active);
    } catch (e) {
      app.error = describeSaveError(e);
    } finally {
      app.connecting = false;
    }
  }

  async function onLoadFile(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    app.error = '';
    loadNote = 'verifying save…';
    preview = null;
    try {
      preview = await previewSave(new Uint8Array(await file.arrayBuffer()));
      resumeTurn = 'latest';
      loadNote = '';
    } catch (e) {
      loadNote = '';
      app.error = describeSaveError(e);
    }
  }

  async function loadPreviewed() {
    if (!preview) return;
    if (!code || !name) {
      app.error = 'enter your name and a room code before loading a save';
      return;
    }
    app.error = '';
    loadNote = 'importing save…';
    try {
      const at = resumeTurn === 'latest' ? undefined : resumeTurn;
      const singlePlayer = preview.envelope.snapshot
        ? (JSON.parse(preview.envelope.snapshot.stateJson) as { settings?: { singlePlayer?: unknown } }).settings?.singlePlayer
        : undefined;
      const res = await importSaveIntoRoom(preview, code, singlePlayer ? 'local' : server, at);
      loadNote = `loaded turn ${res.turn} (players: ${res.players.join(', ')}) — connecting as host…`;
      preview = null;
      if (singlePlayer) {
        const active = await enterSoloGame(name, 'strategic', 'auto', undefined, { code });
        bindActive(active);
      } else await go();
    } catch (e) {
      loadNote = '';
      app.error = describeSaveError(e);
    }
  }

  // auto-join when arriving with a full URL (also the reload/resume path);
  // runs once so leaving a room doesn't bounce straight back in
  $effect(() => {
    if (q.get('room') && q.get('name') && app.screen === 'home' && !app.connecting && !app.error && !app.autoJoined) {
      app.autoJoined = true;
      void go();
    }
  });
</script>

<div class="hero">
<h1>MOO2<span class="v2">v2</span></h1>
<p class="tag">Conquer the stars with friends — peer-to-peer, in your browser.</p>
<div class="form">
  <label>Name <input data-testid="name" bind:value={name} /></label>
  <label>Room code <input data-testid="room" bind:value={code} /></label>
  <label>Players
    <select data-testid="players" bind:value={playerCount}>
      {#each [2, 3, 4, 5, 6, 7, 8] as n (n)}<option value={n}>{n}</option>{/each}
    </select>
  </label>
  <label>Server <input data-testid="server" bind:value={server} size="40" /></label>
  <button data-testid="enter" onclick={go} disabled={app.connecting}>
    {app.connecting ? 'Connecting…' : 'Create / Join'}
  </button>
  <span class="solorow">
    <button data-testid="solo" onclick={goSolo} disabled={app.connecting}
      title="offline game against local bots — no server needed. The room code names the campaign (blank = SOLO): use different codes to keep several bot games going in different tabs, and re-enter a code to resume that campaign">
      🤖 Single player vs {botRows.length > 1 ? `${botRows.length} bots` : 'bot'}{code.trim() ? ` · ${code.trim()}` : ''}
    </button>
    <select data-testid="bot-mode" bind:value={botMode} title="Orion strategic AI uses filtered empire knowledge and normal rules. Legacy modes are upstream comparison sandboxes with full-state policies.">
      <option value="strategic">Orion strategic AI (fair)</option>
      <option value="parity">legacy parity sandbox (debug grants)</option>
      <option value="fair">legacy fair sandbox (full-state policy)</option>
      <option value="onion">legacy OnionAI sandbox (full-state policy)</option>
    </select>
  </span>
  {#if botMode === 'strategic'}
    <label>AI difficulty
      <select data-testid="ai-difficulty" bind:value={difficulty}>
        <option value="easy">Easy (economy and expansion)</option>
        <option value="normal">Normal (economy, expansion and military)</option>
      </select>
    </label>
  {/if}
  {#each botRows as bot, i (i)}
    <span class="botrow" data-testid="bot-row-{i}">
      <span class="botlabel">Bot {i + 1}</span>
      <select data-testid="bot-personality-{i}" bind:value={bot.personality}
        title="play style: expander grabs planets, rusher/militarist come at you early, techer out-researches, industrialist out-builds">
        <option value="auto">random style</option>
        <option value="techer">techer</option>
        <option value="rusher">rusher</option>
        <option value="industrialist">industrialist</option>
        <option value="expander">expander</option>
        <option value="militarist">militarist</option>
      </select>
      <select data-testid="bot-race-{i}" bind:value={bot.race}
        title="bot archetypes rescale their race picks to the lobby's pick-point setting (repulsive + stacked traits); stock races use the fixed presets">
        <optgroup label="bot archetypes (scale with picks)">
          {#each BOT_RACES as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
        </optgroup>
        <optgroup label="stock races">
          <option value="auto">Hivex Commune (default)</option>
          {#each RACE_PRESETS.filter((p) => p.id !== 'hivex') as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
        </optgroup>
      </select>
      <select data-testid="bot-style-{i}" bind:value={bot.shipStyle} title="fleet silhouette family in battles">
        <option value="auto">any hulls</option>
        {#each SHIP_STYLES as s (s.id)}<option value={s.id}>{s.name} hulls</option>{/each}
      </select>
      <select data-testid="bot-color-{i}" bind:value={bot.color} title="banner color"
        style="color:{bot.color === 'auto' ? 'inherit' : bot.color}">
        <option value="auto">seat color</option>
        {#each PLAYER_COLORS as c, ci (c)}<option value={c} style="color:{c}">■ {COLOR_NAMES[ci]}</option>{/each}
      </select>
      {#if botRows.length > 1}
        <button class="botx" data-testid="bot-remove-{i}" title="remove this bot"
          onclick={() => (botRows = botRows.filter((_, j) => j !== i))}>✕</button>
      {/if}
    </span>
  {/each}
  {#if botRows.length < 7}
    <button class="botadd" data-testid="bot-add" onclick={() => (botRows = [...botRows, defaultBot()])}>
      ＋ add another bot
    </button>
  {/if}
  <button data-testid="load-save" onclick={() => fileInput.click()} disabled={app.connecting}>
    Load saved game…
  </button>
  <input
    bind:this={fileInput}
    data-testid="load-file"
    type="file"
    accept=".moo2save,.json,application/octet-stream"
    style="display:none"
    onchange={onLoadFile}
  />
  {#if preview}
    <div class="preview" data-testid="save-preview">
      <p>
        <b>Save verified:</b> turn {preview.verified.turn}, players {preview.players.join(', ')}
        {#if preview.verified.mode === 'snapshot'}
          <span class="warnline" data-testid="save-compat">⚠ from an older build — loads from its snapshot ({preview.verified.warnings.join('; ')})</span>
        {/if}
      </p>
      <label>
        Resume at turn
        <select data-testid="resume-turn" bind:value={resumeTurn}>
          <option value="latest">latest (turn {preview.verified.turn})</option>
          {#each preview.resumeTurns.filter((t) => t > 0 && t < preview!.verified.turn) as t (t)}
            <option value={t}>turn {t} (what-if branch)</option>
          {/each}
        </select>
      </label>
      <span>
        <button data-testid="confirm-load" onclick={loadPreviewed} disabled={app.connecting}>Load as host</button>
        <button onclick={() => (preview = null)}>Cancel</button>
      </span>
      <p class="dim">
        Players joining the room get their old empire back by using the same name they played under
        ({preview.players.join(', ')}); in-game 🤖 controls let a bot stand in for anyone missing.
      </p>
    </div>
  {/if}
  <details class="pbmbox">
    <summary>📬 Play by mail</summary>
    <label>PBM password
      <input type="password" data-testid="pbm-password" bind:value={pbmPassword}
        placeholder={pbmLoggedIn ? 'remembered ✓' : 'shared password'} />
    </label>
    <label>Seat password
      <input type="password" data-testid="pbm-seat-password" bind:value={pbmSeatPassword} placeholder="optional" />
    </label>
    <button data-testid="pbm-enter" onclick={goPbm} disabled={app.connecting}>
      {app.connecting ? 'Connecting…' : '📬 Enter play-by-mail game'}
    </button>
    <p class="dim">
      Uses your name and room code above. One player at a time holds the room; every commit uploads
      your progress, so the game advances whenever the last player mails in their turn. To
      <b>create</b> a play-by-mail game, load a save file above first — it becomes the room's game.
      If someone is playing right now, you join their live game instead. Any downloaded 💾 save of a
      PBM game also resumes normally, so a game can move between play-by-mail and live play freely.
    </p>
  </details>
  {#if loadNote}<p class="dim" data-testid="load-note">{loadNote}</p>{/if}
  {#if app.error}<p class="error" data-testid="error">{app.error}</p>{/if}
</div>
<p class="labline"><a href="#battle-lab">⚗ Battle Lab</a> — build fleets for both sides and watch them fight (balance sandbox)</p>
</div>

<style>
  .hero {
    max-width: 30rem;
    margin: 12vh auto 0;
    padding: 1.6rem 2rem 1.8rem;
    background: linear-gradient(180deg, rgba(21, 29, 63, 0.92), rgba(15, 21, 48, 0.92));
    border: 1px solid var(--line-bright);
    border-radius: 14px;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.5), 0 0 60px rgba(110, 168, 255, 0.08);
  }
  h1 {
    margin: 0;
    font-size: 2.4rem;
    color: var(--accent-soft);
    text-shadow: 0 0 24px rgba(110, 168, 255, 0.5);
  }
  .v2 {
    color: var(--gold);
    font-size: 1.4rem;
    vertical-align: super;
  }
  .tag {
    margin: 0.2rem 0 1.2rem;
    color: var(--text-dim);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  label {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    align-items: center;
  }
  .error {
    color: var(--bad);
  }
  .dim {
    color: var(--text-dim);
  }
  .preview {
    border: 1px solid var(--line-bright);
    border-radius: 8px;
    padding: 0.5rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.9rem;
  }
  .warnline {
    display: block;
    color: var(--gold);
    font-size: 0.82rem;
  }
  .solorow {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .pbmbox {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.4rem 0.8rem;
  }
  .pbmbox summary {
    cursor: pointer;
    color: var(--accent-soft);
  }
  .pbmbox label {
    margin-top: 0.4rem;
  }
  .pbmbox button {
    margin-top: 0.5rem;
    width: 100%;
  }
  .pbmbox .dim {
    font-size: 0.8rem;
  }
  .solorow button {
    flex: 1;
  }
  .botrow {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    font-size: 0.85rem;
  }
  .botrow select {
    flex: 1;
    min-width: 0;
  }
  .botlabel {
    color: var(--text-dim);
    white-space: nowrap;
  }
  .botx {
    padding: 0.1rem 0.4rem;
  }
  .botadd {
    align-self: flex-start;
    font-size: 0.8rem;
    padding: 0.15rem 0.6rem;
  }
  .labline {
    margin: 1rem 0 0;
    font-size: 0.85rem;
    color: var(--text-dim);
  }
  .labline a {
    color: var(--accent-soft);
  }
</style>
