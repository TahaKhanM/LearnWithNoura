/**
 * Curated local educational icons. Every path is original simple geometry
 * authored for this repository (circles, arcs, polylines). No third-party
 * icon library is vendored. Nothing here is fetched at lesson time.
 */

export const BOARD_ASSET_VIEWBOX = 24;

export interface BoardAsset {
  id: string;
  /** Short accessible name announced to the learner. */
  label: string;
  viewBox: typeof BOARD_ASSET_VIEWBOX;
  paths: readonly string[];
}

const V = BOARD_ASSET_VIEWBOX;

function asset(id: string, label: string, paths: readonly string[]): BoardAsset {
  return { id, label, viewBox: V, paths };
}

/**
 * 50 single-color educational silhouettes. Path data is viewBox-normalized
 * to 0 0 24 24 and uses only SVG path letters plus numbers.
 */
const REGISTRY: readonly BoardAsset[] = [
  asset('sun', 'Sun', ['M12 7.5 a4.5 4.5 0 1 1 0 0.01 Z', 'M12 1.5 L12 4', 'M12 20 L12 22.5', 'M1.5 12 L4 12', 'M20 12 L22.5 12', 'M4.2 4.2 L6 6', 'M18 18 L19.8 19.8', 'M19.8 4.2 L18 6', 'M6 18 L4.2 19.8']),
  asset('moon', 'Moon', ['M15 4.2 a8.2 8.2 0 1 0 0 15.6 a6.4 6.4 0 0 1 0 -15.6 Z']),
  asset('cloud', 'Cloud', ['M7 17 h10 a4 4 0 0 0 0 -8 a5.2 5.2 0 0 0 -10.1 -1.2 A3.8 3.8 0 0 0 7 17 Z']),
  asset('raindrop', 'Raindrop', ['M12 3 C12 3 5 11 5 15.5 a7 7 0 0 0 14 0 C19 11 12 3 12 3 Z']),
  asset('snowflake', 'Snowflake', ['M12 2 L12 22', 'M3.5 7 L20.5 17', 'M20.5 7 L3.5 17', 'M12 5 L10.5 3.5 M12 5 L13.5 3.5', 'M12 19 L10.5 20.5 M12 19 L13.5 20.5']),
  asset('lightning', 'Lightning', ['M13 2 L6 13 h6 L11 22 L18 11 h-6 Z']),
  asset('wind', 'Wind', ['M3 8 h12 a2.4 2.4 0 1 0 -2.4 -2.4', 'M3 12 h16 a2.2 2.2 0 1 1 -2.2 2.2', 'M3 16 h10 a2 2 0 1 0 2 2']),
  asset('flame', 'Flame', ['M12 22 c-5 0 -7.5 -4 -7.5 -8.5 C4.5 8 9 5 12 2 c3 3 7.5 6 7.5 11.5 C19.5 18 17 22 12 22 Z', 'M12 22 c-2.2 0 -3.6 -2 -3.6 -4.4 C8.4 15 10.4 13.6 12 12 c1.6 1.6 3.6 3 3.6 5.6 C15.6 20 14.2 22 12 22 Z']),
  asset('leaf', 'Leaf', ['M12 21 C6 16 4 9 12 3 C20 9 18 16 12 21 Z', 'M12 21 L12 8']),
  asset('plant', 'Plant', ['M12 22 L12 11', 'M12 14 C8 14 6 10 8 7 C10 9 12 11 12 14', 'M12 14 C16 14 18 10 16 7 C14 9 12 11 12 14', 'M12 11 C9 8 9 5 12 4 C15 5 15 8 12 11']),
  asset('tree', 'Tree', ['M12 22 L12 14', 'M8 22 L16 22', 'M12 4 L4 15 h16 Z', 'M12 8 L6 16 h12 Z']),
  asset('root', 'Root', ['M12 2 L12 10', 'M12 10 L6 18 L4 22', 'M12 10 L18 18 L20 22', 'M12 12 L9 16', 'M12 12 L15 16']),
  asset('flower', 'Flower', ['M12 12 m-2.2 0 a2.2 2.2 0 1 1 0 0.01 Z', 'M12 5.5 a2.4 2.4 0 1 1 0 0.01 Z', 'M12 18.5 a2.4 2.4 0 1 1 0 0.01 Z', 'M5.5 12 a2.4 2.4 0 1 1 0 0.01 Z', 'M18.5 12 a2.4 2.4 0 1 1 0 0.01 Z']),
  asset('seed', 'Seed', ['M12 4 C16 8 16 16 12 20 C8 16 8 8 12 4 Z']),
  asset('mountain', 'Mountain', ['M2 20 L8 7 L12 14 L16 5 L22 20 Z', 'M8 7 L10.2 11']),
  asset('volcano', 'Volcano', ['M4 21 L9 11 L12 15 L15 9 L20 21 Z', 'M11 6 L12 2 L13 6 L15 5 L13 8 L11 8 L9 5 Z']),
  asset('river', 'River', ['M3 7 C7 4 9 10 13 7 C17 4 19 10 21 7', 'M3 12 C7 9 9 15 13 12 C17 9 19 15 21 12', 'M3 17 C7 14 9 20 13 17 C17 14 19 20 21 17']),
  asset('wave', 'Wave', ['M2 14 C5 8 8 8 11 14 C14 20 17 20 20 14 L22 14', 'M2 18 C5 12 8 12 11 18 C14 24 17 24 20 18']),
  asset('rock', 'Rock', ['M5 18 L7 10 L12 7 L18 11 L20 18 L14 20 Z']),
  asset('bird', 'Bird', ['M3 12 C7 8 11 8 14 11 C16 8 20 7 22 9 C18 11 16 14 14 16 C12 18 8 17 5 15 Z', 'M14 11 L17 10']),
  asset('fish', 'Fish', ['M4 12 C7 7 15 7 19 12 C15 17 7 17 4 12 Z', 'M19 12 L23 8 L23 16 Z', 'M8 11 a0.8 0.8 0 1 1 0 0.01 Z']),
  asset('butterfly', 'Butterfly', ['M12 4 L12 20', 'M12 8 C6 2 2 8 8 12 C2 16 6 22 12 16', 'M12 8 C18 2 22 8 16 12 C22 16 18 22 12 16']),
  asset('rabbit', 'Rabbit', ['M9 14 a5 5 0 1 0 6 0', 'M8 14 C6 6 8 3 10 8', 'M16 14 C18 6 16 3 14 8', 'M10.5 15 a0.6 0.6 0 1 1 0 0.01 Z', 'M13.5 15 a0.6 0.6 0 1 1 0 0.01 Z']),
  asset('atom', 'Atom', ['M12 12 m-1.6 0 a1.6 1.6 0 1 1 0 0.01 Z', 'M12 12 m-9 0 a9 4.2 0 1 1 0 0.01', 'M12 12 m-9 0 a9 4.2 60 1 1 0 0.01', 'M12 12 m-9 0 a9 4.2 -60 1 1 0 0.01']),
  asset('cell', 'Cell', ['M12 12 m-8 0 a8 8 0 1 1 0 0.01 Z', 'M12 12 m-3 0 a3 3 0 1 1 0 0.01 Z', 'M8 8 m-1.2 0 a1.2 1.2 0 1 1 0 0.01 Z', 'M16 10 m-1 0 a1 1 0 1 1 0 0.01 Z']),
  asset('magnet', 'Magnet', ['M7 3 h4 v10 a3 3 0 0 0 6 0 V3 h4 v10 a7 7 0 0 1 -14 0 Z', 'M7 3 h4 v3 h-4 Z', 'M13 3 h4 v3 h-4 Z']),
  asset('battery', 'Battery', ['M6 8 h12 v8 H6 Z', 'M18 10.5 h2 v3 h-2 Z', 'M8 12 h3 M13 12 h3']),
  asset('bulb', 'Bulb', ['M12 3 a6 6 0 0 1 4 10.5 V16 h-8 v-2.5 A6 6 0 0 1 12 3 Z', 'M9 18 h6', 'M9.5 20.5 h5']),
  asset('thermometer', 'Thermometer', ['M12 3 a2 2 0 0 1 2 2 v9.2 a3.6 3.6 0 1 1 -4 0 V5 a2 2 0 0 1 2 -2 Z', 'M12 12 L12 18']),
  asset('beaker', 'Beaker', ['M8 3 h8', 'M9 3 L7 21 h10 L15 3', 'M8 13 h8']),
  asset('flask', 'Flask', ['M10 3 h4 v7 L18 20 H6 L10 10 Z', 'M10 3 h4']),
  asset('microscope', 'Microscope', ['M8 21 h10', 'M12 21 L12 14', 'M9 14 h6', 'M14 8 a3 3 0 1 0 -4 4', 'M10 4 h2 v3 h-2 Z']),
  asset('gear', 'Gear', ['M12 8 a4 4 0 1 1 0 0.01 Z', 'M12 2 L13.2 5.2 L16.5 4.2 L17.2 7.5 L20.5 8.2 L18.8 11 L20.5 13.8 L17.2 14.5 L16.5 17.8 L13.2 16.8 L12 20 L10.8 16.8 L7.5 17.8 L6.8 14.5 L3.5 13.8 L5.2 11 L3.5 8.2 L6.8 7.5 L7.5 4.2 L10.8 5.2 Z']),
  asset('scale', 'Balance scale', ['M12 4 L12 18', 'M6 18 h12', 'M4 10 L12 8 L20 10', 'M4 10 L2 14 h4 Z', 'M20 10 L18 14 h4 Z']),
  asset('prism', 'Prism', ['M4 18 L12 5 L20 18 Z', 'M12 5 L12 18', 'M8 13 L16 13']),
  asset('heart', 'Heart', ['M12 20 C6 15 3 11 3 8 a4.2 4.2 0 0 1 7.2 -3 L12 7 l1.8 -2 A4.2 4.2 0 0 1 21 8 c0 3 -3 7 -9 12 Z']),
  asset('lungs', 'Lungs', ['M12 5 L12 9', 'M12 9 C8 8 4 10 4 15 c0 4 3 5 5 3 L12 12 L15 18 c2 2 5 1 5 -3 c0 -5 -4 -7 -8 -6 Z']),
  asset('brain', 'Brain', ['M7 12 a5 5 0 0 1 5 -6 a5 5 0 0 1 5 6 c1.5 1 2 3 1 5 c-1.2 2.2 -3.5 3 -6 3 s-4.8 -0.8 -6 -3 c-1 -2 -0.5 -4 1 -5 Z', 'M12 6 L12 20']),
  asset('eye', 'Eye', ['M3 12 C6 7 10 5 12 5 C14 5 18 7 21 12 C18 17 14 19 12 19 C10 19 6 17 3 12 Z', 'M12 12 m-2.6 0 a2.6 2.6 0 1 1 0 0.01 Z']),
  asset('globe', 'Globe', ['M12 12 m-8.5 0 a8.5 8.5 0 1 1 0 0.01 Z', 'M12 3.5 L12 20.5', 'M4.2 12 h15.6', 'M6 7 C9 8 15 8 18 7', 'M6 17 C9 16 15 16 18 17']),
  asset('compass', 'Compass', ['M12 12 m-8 0 a8 8 0 1 1 0 0.01 Z', 'M12 5 L14 12 L12 19 L10 12 Z', 'M12 4 L12 2', 'M12 20 L12 22']),
  asset('person', 'Person', ['M12 6 a2.6 2.6 0 1 1 0 0.01 Z', 'M7 21 C7 15 9.5 13 12 13 C14.5 13 17 15 17 21 Z']),
  asset('book', 'Book', ['M4 5 h7 v14 H5 a1 1 0 0 1 -1 -1 Z', 'M13 5 h7 v13 a1 1 0 0 1 -1 1 h-6 Z', 'M12 5 L12 19']),
  asset('pencil', 'Pencil', ['M4 20 L7 17 L18 6 L15 3 L4 14 Z', 'M15 3 L18 6 L20 4 L17 1 Z']),
  asset('cycle', 'Cycle arrows', ['M7 8 a6 6 0 0 1 10 0', 'M17 8 L15 5 L20 6', 'M17 16 a6 6 0 0 1 -10 0', 'M7 16 L9 19 L4 18']),
  asset('star', 'Star', ['M12 3 L14.2 9.2 L21 9.5 L16 13.8 L17.6 20.5 L12 16.8 L6.4 20.5 L8 13.8 L3 9.5 L9.8 9.2 Z']),
  asset('clock', 'Clock', ['M12 12 m-8.5 0 a8.5 8.5 0 1 1 0 0.01 Z', 'M12 7 L12 12 L16 14']),
  asset('ice', 'Ice crystal', ['M12 3 L14 8 L12 10 L10 8 Z', 'M12 21 L14 16 L12 14 L10 16 Z', 'M3 12 L8 10 L10 12 L8 14 Z', 'M21 12 L16 10 L14 12 L16 14 Z']),
  asset('soil', 'Soil', ['M3 16 C6 14 9 18 12 16 C15 14 18 18 21 16 L21 21 H3 Z', 'M6 16 L6 12', 'M12 16 L12 10', 'M17 16 L17 13']),
  asset('speech', 'Speech', ['M5 5 h14 a2 2 0 0 1 2 2 v7 a2 2 0 0 1 -2 2 h-7 L8 21 v-5 H5 a2 2 0 0 1 -2 -2 V7 a2 2 0 0 1 2 -2 Z']),
];

const BY_ID = new Map(REGISTRY.map((entry) => [entry.id, entry]));

export const BOARD_ASSET_IDS: readonly string[] = REGISTRY.map((entry) => entry.id);

export function getBoardAsset(id: string): BoardAsset | undefined {
  return BY_ID.get(id);
}

export function isBoardAssetId(id: string): boolean {
  return BY_ID.has(id);
}
