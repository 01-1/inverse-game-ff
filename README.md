# Inverse

**Inverse** is a first-person detective game about auditing behavior. A city district was run for a year by an optimizer whose stated objective was public, but whose true objective left different consequences in the world.

There is no chat with the policy and no LLM in the game. You walk the district, inspect public records, run costed sandbox probes against the frozen policy, and finally commit at the physical location where the hidden objective left an artifact.

## Run

```sh
npm install
npm run dev
```

Build and test:

```sh
npm run build
npm test
```

## Controls

- `WASD` move
- Mouse look with pointer lock
- `Space` or `E` move up
- `Q` move down
- Left click or `F` inspect the road/building under the reticle
- `Tab` journal
- `B` sandbox
- `G` commit at a suspected artifact building
- `Esc` release pointer / pause

## How It Plays

Case 01 starts after one generated year of history. Shops, warehouses, depots, sensors, the plaza, and the data annex expose public records from that year. The sandbox reruns the frozen policy from the end-of-year state with interventions such as closing a road, spiking a price, or scheduling an event. Probes cost compute budget, so the intended loop is inspect, hypothesize, probe, pin evidence, then physically go to the suspected building and commit.

## Spoilers

The design doc contains the hidden objective for Case 01, the evidence threads, and the intended deduction path:

`docs/DESIGN.md`
