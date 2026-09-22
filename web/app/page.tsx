'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import DropZone from '@/components/DropZone';
import LensSheet from '@/components/LensSheet';
import StatusChip from '@/components/StatusChip';
import { deleteMedia, listMedia, type Media } from '@/lib/api';
import { subscribeToMedia } from '@/lib/ws';

const IN_FLIGHT: Media['status'][] = ['awaiting_upload', 'queued', 'downloading', 'extracting', 'analysing'];
/** Safety net only: the WebSocket carries status changes. */
const POLL_MS = 30_000;

/** Library: the grid of everything dropped in, newest first. */
export default function LibraryPage() {
  const [items, setItems] = useState<Media[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lensOpen, setLensOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const page = await listMedia();
      setItems(page.items);
      setCursor(page.cursor);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load your library');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Pipeline pushes each status change; merge it into whatever is on screen.
  useEffect(() =>
    subscribeToMedia(({ media }) =>
      setItems((prev) => {
        const index = prev.findIndex((m) => m.id === media.id);
        if (index === -1) return [media, ...prev];
        const next = [...prev];
        next[index] = { ...next[index], ...media };
        return next;
      }),
    ),
  []);

  // Anything still in the pipeline means the grid could be stale if the socket dropped.
  useEffect(() => {
    if (!items.some((m) => IN_FLIGHT.includes(m.status))) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [items, refresh]);

  async function loadMore() {
    if (!cursor) return;
    const page = await listMedia(cursor);
    setItems((prev) => [...prev, ...page.items]);
    setCursor(page.cursor);
  }

  async function remove(id: string) {
    setItems((prev) => prev.filter((m) => m.id !== id));
    try {
      await deleteMedia(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'delete failed');
      void refresh();
    }
  }

  return (
    <main className="page">
      <p className="row">
        <Link href="/ask" className="back">
          Ask your library →
        </Link>
        <button className="ghost small" onClick={() => setLensOpen(true)}>
          Search by screenshot
        </button>
      </p>
      {lensOpen && <LensSheet onClose={() => setLensOpen(false)} />}
      <DropZone onAdded={(media) => setItems((prev) => [media, ...prev.filter((m) => m.id !== media.id)])} />

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading your library…</p>
      ) : items.length === 0 ? (
        <p className="muted">Nothing here yet. Drop a reel above.</p>
      ) : (
        <>
          <div className="grid">
            {items.map((media) => (
              <article key={media.id} className="card tile">
                <Link href={`/media/${media.id}`} className="tile-body">
                  <div className="tile-head">
                    <StatusChip media={media} />
                    <span className="muted small">{media.type}</span>
                  </div>
                  <h3>{media.original_filename ?? media.permalink ?? media.id.slice(0, 8)}</h3>
                  <p className="muted small">{new Date(media.created_at).toLocaleString()}</p>
                  {media.error && <p className="error small">{media.error}</p>}
                </Link>
                <button className="ghost small" onClick={() => void remove(media.id)} aria-label="Delete">
                  Delete
                </button>
              </article>
            ))}
          </div>
          {cursor && (
            <button className="ghost" onClick={() => void loadMore()}>
              Load more
            </button>
          )}
        </>
      )}
    </main>
  );
}
