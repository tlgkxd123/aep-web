import { Icon } from "./icons.tsx";

/** AE's Home screen: shown when no project is open, or over the workspace from the Home tool. */
export function HomeScreen({ onOpen, onNew, onDismiss }: { onOpen: () => void; onNew?: () => void; onDismiss?: () => void }) {
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
        <p className="home-lede">
          Drop an <code>.aep</code> file anywhere in this window, or choose one. The project is read in your browser and is
          never uploaded.
        </p>
        <button type="button" className="home-drop" onClick={onOpen}>
          <Icon name="comp" size={40} />
          <span className="home-drop-title">Drop a project here</span>
          <span className="home-drop-sub">or click to choose a file</span>
        </button>
        <section className="home-notes" aria-label="What this viewer shows">
          <h2>What you will see</h2>
          <ul>
            <li>Compositions, footage, solids and folders in the Project panel</li>
            <li>Layers, switches, property values, keyframes and expressions in the Timeline</li>
            <li>Built-in and plug-in effects with their parameters in Effect Controls</li>
            <li>The raw RIFX chunk tree and hex bytes, under Window &gt; RIFX Chunks</li>
          </ul>
          <p>Frames are not rendered yet: the Composition panel shows the comp background and solid layers only.</p>
        </section>
      </main>
    </div>
  );
}
