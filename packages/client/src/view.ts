// Camera angles for the table. Pure helpers (no DOM) so they can be unit-tested.

export type CameraView = "standard" | "overhead" | "pov";

export interface CameraViewInfo {
  id: CameraView;
  label: string;
  key: string;
  title: string;
}

export const CAMERA_VIEWS: readonly CameraViewInfo[] = [
  { id: "standard", label: "Standard", key: "1", title: "Standard angled table view" },
  { id: "overhead", label: "Overhead", key: "2", title: "Top-down bird's-eye view" },
  { id: "pov", label: "POV", key: "3", title: "First-person view from your seat" },
];

export const DEFAULT_VIEW: CameraView = "standard";
export const VIEW_STORAGE_KEY = "bp.view";

export function parseView(v: string | null | undefined): CameraView {
  return CAMERA_VIEWS.some((x) => x.id === v) ? (v as CameraView) : DEFAULT_VIEW;
}

/** Map a keyboard key (1/2/3, incl. numpad digits) to a camera view, or null. */
export function viewForKey(key: string): CameraView | null {
  return CAMERA_VIEWS.find((x) => x.key === key)?.id ?? null;
}

/** Cycle to the next view (used by the V shortcut). */
export function nextView(v: CameraView): CameraView {
  const i = CAMERA_VIEWS.findIndex((x) => x.id === v);
  return CAMERA_VIEWS[(i + 1) % CAMERA_VIEWS.length]!.id;
}

/**
 * Seat-ring radii (percent of the felt) per view. Overhead uses a rounder ring so
 * the whole table is visible from above; POV pushes opponents to the far rail.
 */
export function seatRadii(v: CameraView): { seat: [number, number]; bet: [number, number]; dealer: [number, number] } {
  switch (v) {
    case "overhead": return { seat: [47, 52], bet: [29, 30], dealer: [36, 39] };
    case "pov": return { seat: [50, 60], bet: [30, 34], dealer: [38, 44] };
    default: return { seat: [50, 56], bet: [30, 30], dealer: [38, 40] };
  }
}
