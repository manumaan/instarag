'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { completeConnect } from '@/lib/api';

/**
 * Where Meta sends the browser back.
 *
 * The code is posted to our API from here, behind the app's own sign-in, so it
 * never arrives at an unauthenticated endpoint. The state is checked server
 * side and is single-use.
 */
function Callback() {
  const params = useSearchParams();
  const router = useRouter();
  const [message, setMessage] = useState('Finishing the connection…');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const code = params.get('code');
    const state = params.get('state');
    const denied = params.get('error_description') ?? params.get('error');

    if (denied) {
      setFailed(true);
      setMessage(`Instagram did not grant access: ${denied}`);
      return;
    }
    if (!code || !state) {
      setFailed(true);
      setMessage('That callback had no authorisation code in it.');
      return;
    }

    completeConnect(code, state)
      .then((result) => {
        setMessage(`Connected as ${result.username ?? 'your account'}. Taking you back…`);
        setTimeout(() => router.replace('/connect/'), 1200);
      })
      .catch((err: unknown) => {
        setFailed(true);
        setMessage(err instanceof Error ? err.message : 'the connection could not be completed');
      });
  }, [params, router]);

  return (
    <main className="page">
      <div className="card notice">
        <h1>Instagram</h1>
        <p className={failed ? 'error' : 'muted'}>{message}</p>
        {failed && (
          <button className="ghost" onClick={() => router.replace('/connect/')}>
            Back
          </button>
        )}
      </div>
    </main>
  );
}

export default function ConnectCallbackPage() {
  return (
    <Suspense
      fallback={
        <main className="page">
          <p className="muted">Loading…</p>
        </main>
      }
    >
      <Callback />
    </Suspense>
  );
}
