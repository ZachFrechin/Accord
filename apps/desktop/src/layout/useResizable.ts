import { useCallback, useEffect, useRef, useState } from "react";

/** Direction the handle grows the panel when dragged toward larger values. */
export type ResizeEdge = "left" | "right";

interface UseResizableOptions {
  /** Current committed width (px). */
  width: number;
  /** Commit a new width (store setter, which clamps). */
  onWidth: (px: number) => void;
  /**
   * Which side the drag handle sits on relative to the panel it resizes.
   * "right": handle on the panel's right edge, drag right = wider.
   * "left":  handle on the panel's left edge, drag left = wider.
   */
  edge?: ResizeEdge;
}

interface UseResizableResult {
  /** True while a drag is in progress (for styling the handle). */
  dragging: boolean;
  /** Spread onto the drag-handle element. */
  handleProps: {
    role: "separator";
    "aria-orientation": "vertical";
    tabIndex: 0;
    onPointerDown: (e: React.PointerEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

/** Keyboard step (px) when nudging a panel with arrow keys. */
const KEY_STEP = 16;

/**
 * useResizable — pointer + keyboard driven panel resizing.
 *
 * Returns props for a vertical drag handle. During a pointer drag it tracks the
 * delta from the drag origin and reports the new width through onWidth (the
 * store clamps to bounds). Arrow keys nudge the width for accessibility. Pointer
 * capture keeps the drag alive even if the cursor leaves the handle.
 */
export function useResizable({
  width,
  onWidth,
  edge = "right",
}: UseResizableOptions): UseResizableResult {
  const [dragging, setDragging] = useState(false);
  const origin = useRef({ x: 0, width });
  const dir = edge === "right" ? 1 : -1;

  const onPointerMove = useRef<(e: PointerEvent) => void>(() => {});
  const onPointerUp = useRef<(e: PointerEvent) => void>(() => {});

  // Keep the latest width available to the move handler without re-binding.
  useEffect(() => {
    origin.current.width = width;
  }, [width]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      origin.current = { x: e.clientX, width };
      setDragging(true);

      const move = (ev: PointerEvent) => {
        const delta = (ev.clientX - origin.current.x) * dir;
        onWidth(origin.current.width + delta);
      };
      const up = () => {
        setDragging(false);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      onPointerMove.current = move;
      onPointerUp.current = up;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [width, dir, onWidth],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowRight") onWidth(width + KEY_STEP * dir);
      else if (e.key === "ArrowLeft") onWidth(width - KEY_STEP * dir);
      else return;
      e.preventDefault();
    },
    [width, dir, onWidth],
  );

  // Safety net: detach any lingering listeners on unmount.
  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onPointerMove.current);
      window.removeEventListener("pointerup", onPointerUp.current);
    };
  }, []);

  return {
    dragging,
    handleProps: {
      role: "separator",
      "aria-orientation": "vertical",
      tabIndex: 0,
      onPointerDown: handlePointerDown,
      onKeyDown: handleKeyDown,
    },
  };
}
