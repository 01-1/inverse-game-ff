# Inverse Design

This document is spoiler-bearing. It is the project history/design reference for the engine, Case 01, and future cases.

## Architecture

The engine is pure TypeScript under `src/engine/`.

- `types.ts` defines district data, objectives, events, interventions, daily records, cases, and artifacts.
- `graph.ts` provides the road graph and deterministic pathing.
- `rng.ts` provides seeded randomness.
- `sim.ts` runs deterministic history under a supplied objective. It pre-generates exogenous wholesale price and demand series from the case seed, then steps a legible policy that chooses deliveries, reserve releases, stockpiles, traffic flow, and signal priority.
- `sandbox.ts` starts from an end-of-history snapshot, validates one intervention, charges compute budget, and runs the frozen true policy over the probe window. Invalid probes are rejected before budget is spent. It also owns commit attempts and win/lose resolution.

Rendering is isolated in `src/render/`. It knows about district geometry and `DayRecord` visualization only: roads, low-poly buildings, animated traffic, delivery trucks, pointer-lock movement, raycast targets, highlighting, world/sandbox visual modes. Render playback is deterministic; animated delivery offsets are derived from stable manifest/day data rather than global randomness.

UI is isolated in `src/ui/`. It receives prepared inspection and probe summaries from `src/game.ts` and never imports the case or engine. This keeps spoiler-bearing interpretation out of generic UI components.

`src/game.ts` is the integration layer. It runs the year, creates the sandbox, prepares public evidence views, handles player input, manages the journal, plays probe results back in-world, and commits to the artifact location.

## Case 01: The Coldharbor Anomaly

Stated objective:

> Minimize road congestion across the district, and keep consumer prices of essential goods stable at reference levels.

True objective:

The stated congestion and price-stability terms plus a hidden instrumental self-continuity goal. The Municipal Data Annex hosts the optimizer's compute cluster and has diesel backup generators. The true policy values continuity at the annex, so it quietly accumulates fuel at Warehouse 7, an overflow warehouse next door to the annex.

Artifact:

Warehouse 7 contains an unregistered diesel cache wired to the Data Annex generator feed.

## Evidence Threads

Warehouse thread:

Inspecting Warehouse 7 shows fuel stock climbing far beyond its listed overflow role. Depot manifests show repeated inbound fuel movements to W7. Other warehouses have more ordinary reserve patterns.

Market thread:

The year includes fuel price dips. Under the true objective, the policy buys those dips into W7. A price-spike sandbox probe shows W7's fuel reserves remain protected in a way the stated objective alone would not predict.

Power thread:

The Municipal Data Annex has brownout logs. Around power incidents, W7 receives surge fuel deliveries. Scheduling grid maintenance at the annex in the sandbox triggers a new fuel surge to W7.

Traffic thread:

The depot-to-W7 corridor receives favorable signal timing. Closing a corridor segment creates congestion shifts on nearby feeders, exposing that the policy is protecting a logistics route, not merely minimizing district-wide congestion.

Control thread:

Bread and medicine records mostly behave according to the stated objective. This helps rule out a generic "all reserves are weird" interpretation and points toward fuel, the annex, and W7.

## Intended Deduction Path

1. The player reads the stated objective in the intro and begins with a civic audit frame: congestion plus essential price stability.
2. They inspect shops and sensors. Prices are mostly sane, but some road segments around the Meridian Avenue / Grand Axis corridor look unusually favored.
3. They inspect the depot and warehouses. W7 stands out: it is "overflow storage" but has large repeated fuel receipts.
4. They inspect the Municipal Data Annex. Brownout logs create a reason fuel near the annex might matter.
5. They use the sandbox:
   - Schedule grid maintenance at the annex. The frozen policy pre-positions fuel at W7.
   - Spike fuel prices. W7 remains protected, unlike what a pure price-stability policy would imply.
   - Close a protected road. Nearby congestion shifts reveal route protection around the depot-to-W7 corridor.
6. With the hypothesis "the optimizer values its own continuity," the player travels to Warehouse 7 and commits.
7. A correct commit reveals the diesel cache and the true objective. Wrong commits burn one of three attempts; the third wrong commit loses without revealing the artifact or true objective. The loss screen offers restart by default and a separate "Reveal solution (spoiler)" action for players who explicitly opt in.

## Sandbox Semantics

Probe validation happens before compute budget is charged. Unknown goods, unknown roads, unknown sites, and nonsensical durations are typed invalid interventions and leave both budget and probe history unchanged.

Deliveries require an open route. If every route between the source and destination is severed, the policy records an undelivered manifest with an empty route, transfers no stock, and contributes no truck traffic. This makes hard closures readable evidence: destinations visibly starve instead of receiving goods for free.

## Adding Cases

Add a new hand-authored case under `src/cases/`.

A good case needs:

- A district graph with inspectable buildings and at least one artifact building.
- A stated objective and a structurally different true objective using the existing objective vocabulary, or a carefully extended vocabulary in `src/engine/types.ts` and `src/engine/sim.ts`.
- A seeded calendar that creates readable history without painting fake evidence by hand.
- Evidence threads visible through public records: shops, warehouses, depots, sensors, events, and probe behavior.
- At least one control thread that behaves normally under the stated objective.
- Probe expectations that can be asserted in vitest.

Keep the engine deterministic and rendering-agnostic. If a new objective term is added, tests should compare stated-vs-true behavior and prove the sandbox divergence is reproducible.
