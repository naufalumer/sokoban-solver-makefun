# Sokoban solver — make.fun sokoban-solver-01

A push-optimal Sokoban solver in a single `main.ts` (Node 22, no dependencies,
no network, no clock, no randomness). One run answers all 5 instances of a set.

## How it works

Levels in this competition are a hallway with 1–4 rooms off it, each room
holding 3–4 boxes. A box pushed through a room's one-square door into the
hallway can never return, so the rooms are independent problems and their
push-optima add up to the level's optimum P*.

For each room, in turn, the solver runs an A* search over **pushes**:

- a state is the boxes' squares plus the player's reachable region (named by
  its lowest square); the cost is pushes made;
- the heuristic is the cheapest assignment of boxes to goals by push-distance
  (each push moves exactly one box, so it never overestimates) — admissible
  and consistent, so the first solved state popped is push-optimal;
- dead states are pruned with live-square analysis (reverse-pull from the
  goals: a box off the live set can never reach a goal) and frozen 2×2-block
  detection;
- the other rooms' boxes stand as walls while a room is solved (on their
  goals once their room is done), and the player walks on from where the
  last room left it.

All budgets are counted in expanded states, never in wall time, and every
tie is broken by fixed order, so two runs write byte-identical answers.

## Results (kit practice set, scored with the kit scorer)

| instance | pushes | P* | points |
|----------|--------|----|--------|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

**Practice score: 1,000,000 / 1,000,000** (passed 5/5), in ~0.25 s for the
whole set — against the house baseline plain-astar 1.0.0 at 200,000 (it solves
only i001). The solver also scored 1,000,000 on 16 further sets freshly drawn
from the kit generator with random seeds (all instances at P*, ≤0.5 s each).

## Run locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Licence

MIT — see LICENSE.
