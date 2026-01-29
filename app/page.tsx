"use client";

import dynamic from "next/dynamic";

const ExcalidrawApp = dynamic(() => import("@/components/ExcalidrawApp"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center">Loading...</div>
  ),
});

export default function Home() {
  return <ExcalidrawApp />;
}
