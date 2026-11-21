// Sokoban solver — original implementation written for make.fun sokoban-solver-01.
// Strategy: solve each room independently (a box pushed out of a room through its
// one-square door can never return, so rooms are independent and their push-optima
// add up), with an A* search over pushes inside each room. The search state is the
// boxes' squares plus the player's reachable region; its cost is pushes made and its
// estimate is the cheapest assignment of boxes to goals by push-distance (each push
// moves exactly one box, so the assignment cost never overestimates). Dead states are
// pruned with live-square analysis (a box that can never be pushed to a goal) and
// frozen 2x2-block detection. All budgets are counted in work, never in wall time,
// and every tie is broken by fixed order, so two runs write identical bytes.
// Only Node built-ins are used; no network, no clock, no randomness.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// Work budget per search, counted in expanded states — never the clock, so the
// output is identical on every run. Rooms in this competition are constructed to
// be solvable far below this cap by a push search.
const MAX_EXPANSIONS = 300_000;

type Dir = [number, number, string, string];
const DIRS: Dir[] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Squares from which a box can be pushed onto some goal, found by pulling boxes
// back from the goals (a pull moves a box one square while the player stands on
// the opposite side). A box off this set can never reach a goal: dead square.
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Minimum pushes for a lone box to travel from each square to one goal, ignoring
// the other boxes: reverse breadth-first search in push space from that goal.
function pushDistToGoal(level: Level, goal: number): Int32Array {
  const { w, wall } = level;
  const dist = new Int32Array(wall.length).fill(-1);
  dist[goal] = 0;
  const queue = [goal];
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      // A box at y pushed to x needs the player standing at y - d.
      if (!wall[y] && !wall[y - d] && dist[y] === -1) {
        dist[y] = dist[x]! + 1;
        queue.push(y);
      }
    }
  }
  return dist;
}

// All orderings of goal indices for n boxes (n <= 4), for cheapest assignment.
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push([...cur]);
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

// Whether the box pushed to t is stuck in a 2x2 block of walls and boxes with
// some box of the block off its goal. Such a block can never be broken apart.
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// Flood-fill the player's reachable region from `from` with `occupied` in the
// way; returns its lowest square and marks the region in `seen` with `stamp`.
function reachLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Shortest walk from `from` to `to` around walls and boxes, lower LURD letters.
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

// A* over pushes. A state is the boxes (packed, sorted) and the player's region;
// g is pushes made, h the cheapest box-to-goal assignment by push distance.
// h is admissible (each push moves one box) and consistent (one push changes a
// box's distance by at most one), so the first solved state popped is optimal.
function solvePushAStar(level: Level, maxExpansions: number): SearchResult | null {
  const { w, wall, goals, boxes: startBoxes, player: startPlayer } = level;
  const size = wall.length;
  const n = startBoxes.length;
  if (n === 0) return { pushes: 0, moves: '' };
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (startBoxes.some((b) => !live[b])) return null;
  const distGoal = goals.map((g) => pushDistToGoal(level, g));
  const perms = permutations(n);
  // Cheapest assignment of boxes to goals; Infinity when no box can reach its
  // assigned goal, which prunes the state (no solution can pass through it).
  const heuristic = (bs: number[]): number => {
    let best = Infinity;
    for (const perm of perms) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = distGoal[perm[i]!]![bs[i]!]!;
        if (d < 0) {
          sum = Infinity;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    return best;
  };
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);

  // Pack sorted boxes into one number, base `size + 1`, padded with `size`
  // (a valid digit in this base); exact below 2^53 for these board sizes.
  const BASE = size + 1;
  const pack = (bs: number[]): number => {
    let k = 0;
    for (let i = 0; i < 4; i++) k = k * BASE + (i < bs.length ? bs[i]! : size);
    return k;
  };
  const unpack = (k: number): number[] => {
    const bs: number[] = [];
    const tmp: number[] = [];
    for (let i = 0; i < 4; i++) {
      tmp.push(k % BASE);
      k = Math.floor(k / BASE);
    }
    tmp.reverse();
    for (const b of tmp) if (b !== size) bs.push(b);
    return bs;
  };
  // State key: region's lowest square and packed boxes, exact below 2^53.
  const keyOf = (packed: number, low: number): number => low * BASE ** 4 + packed;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const packed0 = pack(startBoxes);
  for (const b of startBoxes) occupied[b] = 1;
  const low0 = reachLow(level, occupied, startPlayer, seen, ++stamp, stack);
  for (const b of startBoxes) occupied[b] = 0;

  const statesPacked: number[] = [packed0];
  const statesPlayer: number[] = [startPlayer];
  const statesLow: number[] = [low0];
  const statesG: number[] = [0];
  const parent: number[] = [-1];
  const pushDir: number[] = [-1]; // direction index of the push that made the state
  const best = new Map<number, number>([[keyOf(packed0, low0), 0]]);

  // Binary heap on [f, -g, index]: lowest f first, deeper g first on ties, then
  // earliest state first. All tie-breaks are fixed, so the search is identical
  // on every run.
  const heap: [number, number, number][] = [];
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;
  if (solved(startBoxes)) return { pushes: 0, moves: '' };
  heapPush([h0, 0, 0]);
  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, negG, s] = heapPop();
    const g = -negG;
    const packed = statesPacked[s]!;
    const boxes = unpack(packed);
    // Stale entry: a better route to this state was found after this one was queued.
    if ((best.get(keyOf(packed, statesLow[s]!)) ?? Infinity) < g) continue;
    if (solved(boxes)) {
      found = s;
      break;
    }
    if (expanded >= maxExpansions) return null;
    expanded++;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reachLow(level, occupied, statesPlayer[s]!, seen, here, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(level, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        const h = heuristic(next);
        let key = -1;
        let lowNext = -1;
        if (h !== Infinity) {
          lowNext = reachLow(level, occupied, b, mark, ++stamp, stack);
          key = keyOf(pack(next), lowNext);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (h === Infinity || key < 0) continue;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= g + 1) continue;
        best.set(key, g + 1);
        const idx = statesPacked.length;
        statesPacked.push(pack(next));
        statesPlayer.push(b);
        statesLow.push(lowNext);
        statesG.push(g + 1);
        parent.push(s);
        pushDir.push(di);
        heapPush([g + 1 + h, -(g + 1), idx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  // Reconstruct: walk to each push square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes;
  for (const s of path) {
    const nextBoxes = unpack(statesPacked[s]!);
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const di = pushDir[s]!;
    const d = DIRS[di]![1] * w + DIRS[di]![0];
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[di]![3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

// The level's rooms: cut the hallway row's dead squares (a box there reaches no
// goal) out of the floor; each remaining part holding boxes is a room. Null when
// the level is no set of rooms.
function roomsOf(level: Level): { boxes: number[]; goals: number[] }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

// Solve room by room: the other rooms' boxes stand as walls (on their goals once
// their room is done), the player walks on from where the last room left it.
// A box never leaves its room, so the rooms' optima add up to the level's.
function solveByRooms(level: Level): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushAStar(level, MAX_EXPANSIONS);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  const done: boolean[] = rooms.map(() => false);
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const wall = level.wall.slice();
    for (let oj = 0; oj < rooms.length; oj++) {
      if (oj === ri) continue;
      for (const b of done[oj]! ? rooms[oj]!.goals : rooms[oj]!.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: [...room.goals].sort((a, b) => a - b),
      boxes: [...room.boxes].sort((a, b) => a - b),
      player,
    };
    const solvedRoom = solvePushAStar(sub, MAX_EXPANSIONS);
    if (solvedRoom === null) return null;
    pushes += solvedRoom.pushes;
    moves += solvedRoom.moves;
    player = endOf(level.w, player, solvedRoom.moves);
    done[ri] = true;
  }
  return { pushes, moves };
}

function solve(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.every((b) => level.goals.includes(b))) return '';
  const result = solveByRooms(level) ?? solvePushAStar(level, MAX_EXPANSIONS);
  return result === null ? '' : result.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
