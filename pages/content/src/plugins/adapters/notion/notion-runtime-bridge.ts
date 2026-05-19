/**
 * NotionRuntimeBridge — Facade re-export (Slice Q structural refactor).
 *
 * Slice Q extracted implementation into two dedicated modules:
 *   - notion-bridge-controller.ts  — Controller + Factory + BridgeDeps types
 *   - notion-bridge-lane-gate.ts   — Lane Gate + WindowLike + LaneGateDeps types
 *
 * This file is a pure facade providing a stable public import surface.
 * All existing callers (notion.adapter.ts, tests) import from this path unchanged.
 *
 * Dependency DAG: Facade → Lane Gate → Controller (zero ESM cycle).
 *
 * BH-4 TDD: T-BH-19..T-BH-lane-3
 */

export {
    createNotionRuntimeBridge,
} from './notion-bridge-controller.ts';

export type {
    NotionAdapterDelegate,
    NotionRuntimeBridgeDeps,
    NotionRuntimeBridge,
} from './notion-bridge-controller.ts';

export {
    startNotionRuntimeBridgeIfEnabled,
} from './notion-bridge-lane-gate.ts';

export type {
    WindowLike,
    NotionRuntimeBridgeLaneGateDeps,
} from './notion-bridge-lane-gate.ts';
