import { Suspense, lazy } from "react";

// Code-splits CodeMirror (the bulk of the main bundle) into a lazy chunk.
const Inner = lazy(() => import("./FsFileView.js").then((m) => ({ default: m.FsFileView })));

export function LazyFsFileView(): JSX.Element {
  return (
    <Suspense fallback={<div style={{ padding: 16, color: "var(--text-muted)", fontSize: 12 }}>loading editor…</div>}>
      <Inner />
    </Suspense>
  );
}
