'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { findSimilar, lensUpload, type SimilarMatch } from '@/lib/api';

const ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * Lens: search the library with a screenshot, or from a frame already in it.
 *
 * The query image goes to its own S3 prefix, not into the library — it is a
 * question, not a reel, and it expires on a lifecycle rule.
 */
export default function LensSheet({
  frame,
  onClose,
}: {
  /** Set when opened from a frame instead of an upload. */
  frame?: { mediaId: string; tsMs: number };
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [matches, setMatches] = useState<SimilarMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queryPreview, setQueryPreview] = useState<string | null>(null);

  async function search(run: () => Promise<{ matches: SimilarMatch[] }>) {
    setBusy(true);
    setError(null);
    try {
      setMatches((await run()).matches);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'the search failed');
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    setQueryPreview(URL.createObjectURL(file));
    await search(async () => {
      const { s3Key } = await lensUpload(file);
      return findSimilar({ s3Key });
    });
  }

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <section className="sheet card" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Lens</h2>
          <button className="ghost small" onClick={onClose}>
            Close
          </button>
        </div>

        {frame ? (
          <p className="muted small">
            Frames that look like this one, at {(frame.tsMs / 1000).toFixed(1)}s.
          </p>
        ) : (
          <>
            <div
              className="dropzone"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files[0]) void onFile(e.dataTransfer.files[0]);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
            >
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT}
                hidden
                onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])}
              />
              <p>
                <strong>Drop a screenshot to find it in your library</strong>
              </p>
              <p className="muted small">jpg, png or webp</p>
            </div>
            {queryPreview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="lens-query" src={queryPreview} alt="the screenshot being searched with" />
            )}
          </>
        )}

        {frame && !matches && !busy && (
          <button className="primary" onClick={() => void search(() => findSimilar(frame))}>
            Find similar frames
          </button>
        )}

        {busy && <p className="muted small">Searching…</p>}
        {error && <p className="error small">{error}</p>}

        {matches && (
          <>
            {matches.length === 0 ? (
              <p className="muted small">Nothing in your library looks like that.</p>
            ) : (
              <div className="lens-results">
                {matches.map((match) => (
                  <Link
                    key={`${match.media_id}:${match.ts_ms}`}
                    className="lens-hit"
                    href={`/media/${match.media_id}?t=${match.ts_ms}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {match.url && <img src={match.url} alt={match.description} />}
                    <span className="small">
                      {(match.ts_ms / 1000).toFixed(1)}s · {(match.score * 100).toFixed(0)}%
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
