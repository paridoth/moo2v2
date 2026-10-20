// Reproducible matched-race comparisons through the real host/session path.
// No proprietary install, external AI provider or new runtime dependency.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('npm run benchmark:orion -- [--turns 150] [--output benchmark-results/orion.json]');
  process.exit(0);
}
let turns = 150;
let output = 'benchmark-results/orion.json';
for (let i = 0; i < args.length; i += 2) {
  const value = args[i + 1];
  if (value === undefined) throw new Error(`missing value for ${args[i]}`);
  if (args[i] === '--turns') turns = Number(value);
  else if (args[i] === '--output') output = value;
  else throw new Error(`unknown option ${args[i]}`);
}
if (!Number.isSafeInteger(turns) || turns < 1 || turns > 1000) throw new Error('--turns must be 1..1000');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({ root, configFile: false, server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, entries: [] },
  resolve: { alias: Object.fromEntries(['engine', 'ai', 'protocol', 'storage'].map((name) => [`@${name}`, resolve(root, 'src', name)])) },
});
try {
  const { runStrategicMatch } = await server.ssrLoadModule('/src/headless/orion-match.ts');
  const scenarios = [
    { seed: '0123456789abcdef0123456789abcdef', startMode: 'average', race: 'solari' },
    { seed: 'fedcba9876543210fedcba9876543210', startMode: 'pre_warp', race: 'ferron' },
    { seed: 'abcdef0123456789abcdef0123456789', startMode: 'advanced', race: 'urgok' },
  ];
  const results = [];
  const path = resolve(root, output);
  await mkdir(dirname(path), { recursive: true });
  for (const scenario of scenarios) for (const strategies of [['strategist-v3', 'strategist-v2'], ['strategist-v2', 'strategist-v3']]) {
    const result = await runStrategicMatch({ seed: scenario.seed, turns,
      settings: { startMode: scenario.startMode, modes: { creativeVariant: false, pickBidding: false,
        stickyBuild: false, antarans: false, randomEvents: false } },
      seats: strategies.map((strategy) => ({ strategy, race: scenario.race, personality: 'militarist' })) });
    results.push(result);
    await writeFile(path, JSON.stringify({ format: 1, note: 'Turn-cap outcomes are unfinished games, not victories.', results }, null, 2) + '\n');
    console.log(`${scenario.startMode}/${scenario.race} ${strategies.join(' vs ')} turn=${result.finalTurn} winner=${result.winner ?? 'unfinished'} `
      + result.metrics.map((m) => `seat${m.id}: ${m.colonies} colonies, ${m.technologies} tech, ${m.shipsRefitted} refits, ${m.starvation} food lack`).join(' | '));
    if (result.diagnostics.some((d) => d.rejected || d.bounded)) throw new Error(`benchmark rejected/bounded orders; inspect ${path}`);
  }
  const rows = results.flatMap((r) => r.metrics.map((m) => `| ${r.options.settings.startMode} | ${r.options.seats[m.id].race} | ${m.id} | ${r.options.seats[m.id].strategy} | ${m.colonies} | ${m.technologies} | ${m.researchPerTurn} | ${m.warships} | ${m.shipsRefitted} | ${m.idleProduction} | ${m.starvation} | ${r.winner === null ? 'unfinished' : r.winner === m.id ? 'win' : 'loss'} |`));
  await writeFile(`${path}.md`, ['# Orion matched-seat benchmark', '',
    `${turns} requested turns per match. Every result validates accepted commands and full-log replay.`,
    'Each scenario swaps seats with identical races and personalities. Turn-cap games are unfinished; these metrics do not establish competitive win rates.', '',
    '| Start | Race | Seat | Policy | Colonies | New tech | RP/turn | Warships | Refits completed | Idle production | Food lack | Outcome |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |', ...rows, ''].join('\n'));
  console.log(`Results: ${path}\nReport: ${path}.md`);
} finally { await server.close(); }
