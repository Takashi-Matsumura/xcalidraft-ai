"use client";

import { useState, useCallback } from "react";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import ExcalidrawWrapper from "./ExcalidrawWrapper";
import AIChatPanel from "./AIChatPanel";

export default function ExcalidrawApp() {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  const handleAPIReady = useCallback((excalidrawAPI: ExcalidrawImperativeAPI) => {
    setApi(excalidrawAPI);
  }, []);

  const handleElementsGenerated = useCallback(
    (skeletons: unknown[]) => {
      if (!api) return;

      const newElements = convertToExcalidrawElements(
        skeletons as Parameters<typeof convertToExcalidrawElements>[0],
        { regenerateIds: true },
      );

      const existing = api.getSceneElements();
      api.updateScene({
        elements: [...existing, ...newElements],
      });

      setTimeout(() => {
        api.scrollToContent(newElements, { fitToViewport: true });
      }, 100);
    },
    [api],
  );

  return (
    <div className="flex h-screen w-screen">
      <div className="flex-1 relative">
        <ExcalidrawWrapper onAPIReady={handleAPIReady} />
      </div>
      <AIChatPanel onElementsGenerated={handleElementsGenerated} />
    </div>
  );
}
