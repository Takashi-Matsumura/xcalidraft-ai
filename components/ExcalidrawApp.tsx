"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  convertToExcalidrawElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import ExcalidrawWrapper from "./ExcalidrawWrapper";
import AIChatPanel from "./AIChatPanel";

const CANVAS_STORAGE_KEY = "excalidraft-canvas";

// Normalize linear elements: ensure points[0] is [0,0] and adjust x,y accordingly
// convertToExcalidrawElements binding shifts points but doesn't re-normalize
// Normalize linear elements on plain JSON objects (after deep clone)
// Also fix binding focus values that fall outside the valid range [-1, 1]
function normalizeLinearElements(elements: Record<string, unknown>[]) {
  for (const el of elements) {
    if (el.type !== "arrow" && el.type !== "line") continue;
    const points = el.points as number[][];
    if (!points || points.length < 2) continue;

    const [dx, dy] = points[0];
    if (dx !== 0 || dy !== 0) {
      // Shift all points so first is [0,0], and adjust element position
      el.x = (el.x as number) + dx;
      el.y = (el.y as number) + dy;
      el.points = points.map(([px, py]) => [px - dx, py - dy]);
    }

    // Fix invalid focus values on bindings
    // convertToExcalidrawElements can compute focus outside [-1, 1]
    // when LLM-specified arrow coordinates don't align with shape boundaries
    const startBinding = el.startBinding as Record<string, unknown> | null;
    if (startBinding && typeof startBinding.focus === "number") {
      startBinding.focus = Math.max(-1, Math.min(1, startBinding.focus));
    }
    const endBinding = el.endBinding as Record<string, unknown> | null;
    if (endBinding && typeof endBinding.focus === "number") {
      endBinding.focus = Math.max(-1, Math.min(1, endBinding.focus));
    }
  }
}

let batchCounter = 0;

// Add unique prefix to all IDs in skeletons to avoid collisions across batches
function prefixIds(skeletons: Record<string, unknown>[]): Record<string, unknown>[] {
  const prefix = `b${++batchCounter}_`;
  const idMap = new Map<string, string>();

  // First pass: collect all IDs and create mappings
  for (const s of skeletons) {
    if (typeof s.id === "string") {
      idMap.set(s.id, prefix + s.id);
    }
  }

  // Second pass: update all ID references
  return skeletons.map((s) => {
    const updated = { ...s };

    // Update element's own ID
    if (typeof updated.id === "string") {
      updated.id = idMap.get(updated.id) || updated.id;
    }

    // Update arrow start/end references
    if (updated.start && typeof updated.start === "object") {
      const start = updated.start as Record<string, unknown>;
      if (typeof start.id === "string" && idMap.has(start.id)) {
        updated.start = { ...start, id: idMap.get(start.id) };
      }
    }
    if (updated.end && typeof updated.end === "object") {
      const end = updated.end as Record<string, unknown>;
      if (typeof end.id === "string" && idMap.has(end.id)) {
        updated.end = { ...end, id: idMap.get(end.id) };
      }
    }

    return updated;
  });
}

export default function ExcalidrawApp() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAPIReady = useCallback(
    (excalidrawAPI: ExcalidrawImperativeAPI) => {
      setApi(excalidrawAPI);
    },
    [],
  );

  const hasRestoredRef = useRef(false);
  useEffect(() => {
    if (!api || hasRestoredRef.current) return;
    hasRestoredRef.current = true;
    try {
      const saved = localStorage.getItem(CANVAS_STORAGE_KEY);
      if (saved) {
        const elements = JSON.parse(saved);
        if (Array.isArray(elements) && elements.length > 0) {
          api.updateScene({ elements });
          api.scrollToContent(elements, { fitToViewport: true });
        }
      }
    } catch {
      // ignore
    }
  }, [api]);

  const saveCanvasToStorage = useCallback(
    (elements: readonly unknown[]) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        try {
          localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(elements));
        } catch {
          // ignore
        }
      }, 2000);
    },
    [],
  );

  const handleElementsGenerated = useCallback(
    (skeletons: unknown[], action: string) => {
      if (!api) return;

      const typed = skeletons as Record<string, unknown>[];

      // For "add" action, prefix IDs to avoid collision with existing elements
      const processedSkeletons =
        action === "add" ? prefixIds(typed) : typed;

      // Convert skeletons to Excalidraw elements (handles bindings internally)
      const rawElements = convertToExcalidrawElements(
        processedSkeletons as Parameters<typeof convertToExcalidrawElements>[0],
        { regenerateIds: false },
      );

      // Deep clone to break internal cached references, normalize arrows,
      // then restore through restoreElements for proper Excalidraw objects
      const cloned = JSON.parse(JSON.stringify(rawElements));
      normalizeLinearElements(cloned);
      const newElements = restoreElements(cloned, null, {
        refreshDimensions: false,
        repairBindings: true,
      });

      if (action === "replace") {
        api.updateScene({ elements: newElements });
      } else if (action === "modify") {
        const existing = api.getSceneElements();
        const incomingById = new Map<string, (typeof newElements)[number]>();
        for (const el of newElements) {
          if (el.id) incomingById.set(el.id, el);
        }
        const updatedElements = existing.map((el) => {
          const replacement = incomingById.get(el.id);
          if (replacement) {
            incomingById.delete(el.id);
            return replacement;
          }
          return el;
        });
        const remainingNew = Array.from(incomingById.values());
        api.updateScene({ elements: [...updatedElements, ...remainingNew] });
      } else {
        // "add"
        const existing = api.getSceneElements();
        api.updateScene({ elements: [...existing, ...newElements] });
      }

      setTimeout(() => {
        api.scrollToContent(newElements, { fitToViewport: true });
      }, 100);
    },
    [api],
  );

  const getCanvasContext = useCallback((): string => {
    if (!api) return "";
    const elements = api.getSceneElements();
    if (!elements || elements.length === 0) return "Canvas is empty.";

    const limited = elements.slice(0, 50);
    const summary = limited.map((el) => {
      const base: Record<string, unknown> = {
        id: el.id,
        type: el.type,
        x: Math.round(el.x),
        y: Math.round(el.y),
        width: Math.round(el.width),
        height: Math.round(el.height),
      };
      const elAny = el as Record<string, unknown>;
      if (elAny.type === "text" && typeof elAny.text === "string") {
        base.text = elAny.text;
      }
      if (elAny.backgroundColor) base.backgroundColor = elAny.backgroundColor;
      return base;
    });

    let context = `${elements.length} elements on canvas`;
    if (elements.length > 50) context += ` (showing first 50)`;
    context += `:\n${JSON.stringify(summary, null, 1)}`;
    return context;
  }, [api]);

  const handleClearCanvas = useCallback(() => {
    if (!api) return;
    api.updateScene({ elements: [] });
    localStorage.removeItem(CANVAS_STORAGE_KEY);
  }, [api]);

  return (
    <div className="flex h-screen w-screen">
      <div className="flex-1 relative">
        <ExcalidrawWrapper
          onAPIReady={handleAPIReady}
          onCanvasChange={saveCanvasToStorage}
        />
      </div>
      <AIChatPanel
        onElementsGenerated={handleElementsGenerated}
        getCanvasContext={getCanvasContext}
        onClearCanvas={handleClearCanvas}
      />
    </div>
  );
}
