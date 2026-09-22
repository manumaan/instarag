'use client';

import { useState } from 'react';
import { ask, type AskAnswer, type Citation } from '@/lib/api';

interface Turn {
  question: string;
  answer?: AskAnswer;
  error?: string;
}

/**
 * Ask, scoped to one reel when `mediaId` is given or to the whole library
 * otherwise. Citations are the point: `onCite` lets the reel detail screen
 * seek its player, and the library view links out to the reel instead.
 */
export default function AskPanel({
  mediaId,
  onCite,
  renderCitation,
}: {
  mediaId?: string;
  onCite?: (citation: Citation) => void;
  renderCitation?: (citation: Citation) => React.ReactNode;
}) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const asked = question.trim();
    if (!asked || busy) return;

    setQuestion('');
    setBusy(true);
    setTurns((prev) => [...prev, { question: asked }]);
    try {
      const answer = await ask(asked, { mediaId, threadId });
      setThreadId(answer.threadId ?? undefined);
      setTurns((prev) => prev.map((turn, i) => (i === prev.length - 1 ? { ...turn, answer } : turn)));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'the question failed';
      setTurns((prev) => prev.map((turn, i) => (i === prev.length - 1 ? { ...turn, error: message } : turn)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ask">
      <h2>Ask</h2>

      {turns.length === 0 && (
        <p className="muted small">
          {mediaId
            ? 'Ask about this reel — "which cafe is shown here?"'
            : 'Ask about anything in your library. Answers cite the frame they came from.'}
        </p>
      )}

      <div className="turns">
        {turns.map((turn, i) => (
          <div key={i} className="turn">
            <p className="question">{turn.question}</p>
            {turn.error && <p className="error small">{turn.error}</p>}
            {turn.answer && (
              <>
                <p className={turn.answer.answered ? undefined : 'muted'}>{turn.answer.answer}</p>
                {turn.answer.citations.length > 0 && (
                  <div className="citations">
                    {turn.answer.citations.map((citation, j) =>
                      renderCitation ? (
                        <span key={j}>{renderCitation(citation)}</span>
                      ) : (
                        <button key={j} className="evidence" onClick={() => onCite?.(citation)}>
                          {(citation.ts_ms / 1000).toFixed(1)}s
                        </button>
                      ),
                    )}
                  </div>
                )}
                {!turn.answer.answered && (
                  <p className="muted small">Not supported by what has been indexed.</p>
                )}
              </>
            )}
            {!turn.answer && !turn.error && <p className="muted small">Thinking…</p>}
          </div>
        ))}
      </div>

      <form className="url-form" onSubmit={submit}>
        <input
          type="text"
          placeholder={mediaId ? 'Ask about this reel…' : 'Ask about your library…'}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
        />
        <button className="primary" type="submit" disabled={busy || !question.trim()}>
          Ask
        </button>
      </form>
    </section>
  );
}
