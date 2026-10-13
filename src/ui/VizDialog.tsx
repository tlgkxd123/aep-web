// Opening an Avee Player template (.viz): the song the converted project is built around.
import { useState, type FormEvent } from "react";
import { SONG_ACCEPT } from "../quickstart/create.ts";
import type { VizTemplate } from "../viz/scene.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./icons.tsx";
import { FilePick } from "./QuickStart.tsx";

export function VizDialog({
  template,
  onCreate,
  onCancel,
}: {
  template: VizTemplate;
  /** Converts and opens the project; rejects, saying why, when it cannot. */
  onCreate: (song: File | undefined) => Promise<void>;
  onCancel: () => void;
}) {
  const [song, setSong] = useState<File>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const { compositions } = template.scene;
  const elements = compositions.reduce((n, c) => n + c.filter((e) => e.objType !== "AudioProvider").length, 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (working) return;
    setWorking(true);
    setError(undefined);
    try {
      await onCreate(song);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog title="Avee Player Template" className="quick-start" onCancel={() => !working && onCancel()}>
      <form onSubmit={(e) => void submit(e)}>
        <div className="qs-head">
          <div>
            <h3>{template.name}</h3>
            <p>{`${elements} elements in ${compositions.length} compositions, converted to an After Effects project.`}</p>
          </div>
        </div>
        <FilePick
          label="Song"
          hint="An MP3 or WAV file, or a movie with sound"
          accept={SONG_ACCEPT}
          file={song}
          disabled={working}
          onFile={(file) => {
            setSong(file);
            setError(undefined);
          }}
        />
        <p className="qs-hint">The spectrum bars and what moves with the beat are built from the song, keyed on the Controls layer's Beat slider. Without one, the comps last 30 seconds and stay still.</p>
        {error && (
          <p className="dialog-error" role="alert">
            <Icon name="warning" size={12} /> {error}
          </p>
        )}
        <div className="dialog-actions">
          {working && (
            <span className="qs-status" role="status">
              Converting the template…
            </span>
          )}
          <span className="dialog-spacer" />
          <button type="button" className="ae-secondary" disabled={working} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="ae-primary" disabled={working}>
            Convert
          </button>
        </div>
      </form>
    </Dialog>
  );
}
