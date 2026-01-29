"use client";

import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

interface Props {
  onAPIReady: (api: ExcalidrawImperativeAPI) => void;
  onCanvasChange?: (elements: readonly unknown[]) => void;
}

export default function ExcalidrawWrapper({ onAPIReady, onCanvasChange }: Props) {
  return (
    <div style={{ width: "100%", height: "100%" }}>
      <Excalidraw
        excalidrawAPI={onAPIReady}
        onChange={(elements) => {
          onCanvasChange?.(elements);
        }}
      />
    </div>
  );
}
