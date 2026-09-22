'use client';

import { useRef, useState } from 'react';
import { addFromUrl, uploadFile, type Media } from '@/lib/api';

const ACCEPT = 'video/mp4,video/quicktime,video/webm,image/jpeg,image/png,image/webp';

/** Drop-in mode entry point: a screen recording, screenshots, or a pasted permalink. */
export default function DropZone({ onAdded }: { onAdded: (media: Media) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{ name: string; fraction: number } | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleFiles(files: FileList | File[]) {
    setError(null);
    for (const file of Array.from(files)) {
      try {
        setProgress({ name: file.name, fraction: 0 });
        const media = await uploadFile(file, (fraction) => setProgress({ name: file.name, fraction }));
        onAdded(media);
      } catch (err) {
        setError(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
      } finally {
        setProgress(null);
      }
    }
  }

  async function handleUrl(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const { media } = await addFromUrl(url);
      setUrl('');
      onAdded(media);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not add that link');
    }
  }

  return (
    <section className="dropzone-wrap">
      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => e.target.files && void handleFiles(e.target.files)}
        />
        {progress ? (
          <>
            <p>
              Uploading <strong>{progress.name}</strong>
            </p>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
            </div>
          </>
        ) : (
          <>
            <p>
              <strong>Drop a screen recording or screenshots</strong>
            </p>
            <p className="muted small">mp4, mov, webm, jpg, png, webp — up to 500 MB</p>
          </>
        )}
      </div>

      <form className="url-form" onSubmit={handleUrl}>
        <input
          type="url"
          placeholder="…or paste an instagram.com/reel/… link"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
        />
        <button className="primary" type="submit">
          Add link
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
