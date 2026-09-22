'use client';

import Link from 'next/link';
import AskPanel from '@/components/AskPanel';

/** Library-scoped Ask: citations link out to the reel they came from. */
export default function AskPage() {
  return (
    <main className="page">
      <Link href="/" className="back">
        ← Library
      </Link>
      <div className="card">
        <AskPanel
          renderCitation={(citation) => (
            <Link className="evidence" href={`/media?id=${citation.media_id}&t=${citation.ts_ms}`}>
              {citation.media_id.slice(0, 8)} @ {(citation.ts_ms / 1000).toFixed(1)}s
            </Link>
          )}
        />
      </div>
    </main>
  );
}
