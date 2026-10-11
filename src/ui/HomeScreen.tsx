import { Capacitor } from "@capacitor/core";
import type { QuickStartId } from "../quickstart/catalog.ts";
import { Icon } from "./icons.tsx";
import { QuickStartCards } from "./QuickStart.tsx";
import { isMobileOS } from "./responsive.ts";

/** How projects get into the app on this platform, as the Home screen tells it. */
function openingHint(): { lede: string; title: string; sub: string } {
  const where = "The project is read on this device and is never uploaded.";
  if (Capacitor.isNativePlatform())
    return {
      lede: `Choose an .aep file, or open one from your file manager or another app with Open with or Share. ${where}`,
      title: "Choose a project",
      sub: "Tap to browse your files",
    };
  if (isMobileOS()) return { lede: `Choose an .aep file from your files. ${where}`, title: "Choose a project", sub: "Tap to browse your files" };
  return {
    lede: `Drop an .aep file anywhere in this window, or choose one. Installed as an app, AEP Web also opens .aep files from your file manager. ${where}`,
    title: "Drop a project here",
    sub: "or click to choose a file",
  };
}

/** AE's Home screen: shown when no project is open, or over the workspace from the Home tool. */
export function HomeScreen({
  onOpen,
  onNew,
  onTemplate,
  onDismiss,
}: {
  onOpen: () => void;
  onNew?: () => void;
  /** Starts a project from a Quick Start template. */
  onTemplate?: (id: QuickStartId) => void;
  onDismiss?: () => void;
}) {
  const hint = openingHint();
  return (
    <div className="home" role="region" aria-label="Home">
      <aside className="home-rail">
        {onNew && (
          <button type="button" className="ae-primary" onClick={onNew}>
            New Project
          </button>
        )}
        <button type="button" className={onNew ? "ae-secondary" : "ae-primary"} onClick={onOpen}>
          Open Project
        </button>
        {onDismiss && (
          <button type="button" className="ae-secondary" onClick={onDismiss}>
            Back to Project
          </button>
        )}
        <nav className="home-nav" aria-label="Home sections">
          <span className="home-nav-item active" aria-current="page">
            <Icon name="home" size={14} />
            Home
          </span>
        </nav>
      </aside>
      <main className="home-main">
        <h1>Open an After Effects project</h1>
        <p className="home-lede">{hint.lede}</p>
        <button type="button" className="home-drop" onClick={onOpen}>
          <Icon name="comp" size={40} />
          <span className="home-drop-title">{hint.title}</span>
          <span className="home-drop-sub">{hint.sub}</span>
        </button>
        {onTemplate && <QuickStartCards onChoose={onTemplate} />}
        <section className="home-notes" aria-label="What this viewer shows">
          <h2>What you will see</h2>
          <ul>
            <li>Compositions rendered in the Composition panel with WebGL2, on this device's GPU</li>
            <li>Compositions, footage, solids and folders in the Project panel</li>
            <li>Layers, switches, property values, keyframes and expressions in the Timeline</li>
            <li>Built-in and plug-in effects with their parameters in Effect Controls</li>
            <li>The raw RIFX chunk tree and hex bytes, under Window &gt; RIFX Chunks</li>
          </ul>
        </section>
      </main>
    </div>
  );
}
