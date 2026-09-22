'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  connectionStatus,
  disconnectInstagram,
  startConnect,
  syncInstagram,
  type ConnectionStatus,
  type SyncResult,
} from '@/lib/api';

/**
 * Connected mode: link the owner's own Instagram account.
 *
 * This reaches the connected account's own media only. It is not a route to
 * other people's reels — drop-in mode is — and it uses no Instagram password,
 * cookie or session.
 */
export default function ConnectPage() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await connectionStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not read the connection');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'that did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <Link href="/" className="back">
        ← Library
      </Link>

      <div className="card">
        <h2>Instagram</h2>

        {!status ? (
          <p className="muted small">Checking…</p>
        ) : !status.configured ? (
          <>
            <p className="muted">
              Not configured yet. Connected mode needs a Meta app: its app id deployed as
              <code> instagramAppId</code>, and its app secret put into the stack&apos;s secret.
            </p>
            <p className="muted small">
              This covers your own media only. Other people&apos;s reels go through the drop zone on the
              library page.
            </p>
          </>
        ) : status.connected ? (
          <>
            <p>
              Connected as <strong>{status.username ?? status.igUserId}</strong>
            </p>
            <p className="muted small">
              Token valid for {status.daysLeft} more day{status.daysLeft === 1 ? '' : 's'}; it refreshes
              itself daily.
              {status.lastSyncAt && ` Last sync ${new Date(status.lastSyncAt).toLocaleString()}.`}
            </p>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => void act(async () => setSync(await syncInstagram()))}>
                {busy ? 'Syncing…' : 'Sync my reels'}
              </button>
              <button className="ghost" disabled={busy} onClick={() => void act(disconnectInstagram)}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              Link your Instagram Business or Creator account to pull in your own reels.
            </p>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const { authorizeUrl } = await startConnect();
                  window.location.href = authorizeUrl;
                })
              }
            >
              Connect Instagram
            </button>
          </>
        )}

        {error && <p className="error small">{error}</p>}

        {sync && (
          <>
            <h2>Last sync</h2>
            <p className="muted small">Checked {sync.checked} item(s).</p>
            <ul className="places">
              {sync.results.map((result) => (
                <li key={result.ig_media_id}>
                  <span className={`chip${result.status === 'ingesting' ? ' chip-ready' : ''}`}>{result.status}</span>{' '}
                  <span className="muted small">
                    {result.ig_media_id}
                    {result.reason ? ` — ${result.reason}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
