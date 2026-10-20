# Orion Ascendant

Build a playable modern spiritual successor to Master of Orion II on MOO2v2,
with capable alien civilizations and detailed empire management. Use original
names, prose, artwork and audio. The existing engine, UI, SQLite storage and
multiplayer protocol remain the foundation.

The first release milestone is an offline human campaign against two fair
computer empires. The human chooses a race (or custom picks), galaxy and existing
rules, issues orders, and ends the turn. Computers play their own seats; the
normal deterministic pipeline resolves the world and supplies reports. Saving,
loading and replaying must preserve the campaign and its computer seats.

Strategic depth takes priority over cosmetic expansion: food, production,
science, money, technology choices, exploration, colonization, design, military
operations, diplomacy and victory paths all remain available.

The long-term distinction is intelligent civilizations: strategic goals,
personalities that affect decisions, persistent relationships and diplomatic
memory. Optional conversational diplomacy will use a filtered observation and
structured proposals. It will never directly mutate simulation state, reveal
private opponent information, or be needed to play/replay a game.

This milestone does not claim complete classic fidelity or competitive strategic
AI. See [CLASSIC_FIDELITY](CLASSIC_FIDELITY.md), [AI_DESIGN](AI_DESIGN.md) and the
[roadmap](ORION_ROADMAP.md) for evidence and remaining work.
