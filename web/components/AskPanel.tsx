'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ask,
  getThread,
  looksLikePlan,
  sourceLabel,
  startPlan,
  warmSearch,
  type AskAnswer,
  type Citation,
  type Plan,
  type Source,
} from '@/lib/api';

type Mode = 'answer' | 'plan';

interface Turn {
  question: string;
  mode: Mode;
  answer?: AskAnswer;
  plan?: Plan;
  /** Plans only, while the worker is still building. */
  building?: boolean;
  sources?: Source[];
  unsupported?: boolean;
  error?: string;
}

/** A plan takes about a minute; give up well after that rather than forever. */
const POLL_MS = 3000;
const POLL_LIMIT = 80;

/**
 * Ask, scoped to one reel when `mediaId` is given or to the whole library
 * otherwise. Citations are the point: `onCite` lets the reel detail screen
 * seek its player, and the library view links out to the reel instead.
 *
 * Two modes. An answer pins one fact and cites it. A plan is built out of the
 * whole library — "a travel plan for Istanbul with all the tips" — which needs
 * far more of the index, so it is built in the background and polled for.
 */
export default function AskPanel({
  mediaId,
  onCite,
  renderCitation,
  label,
}: {
  mediaId?: string;
  onCite?: (citation: Citation) => void;
  renderCitation?: (citation: Citation) => React.ReactNode;
  /** A carousel cites slides, not seconds. */
  label?: (citation: Citation) => string;
}) {
  const [question, setQuestion] = useState('');
  const [forcedMode, setForcedMode] = useState<Mode | undefined>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  /*
   * The index sleeps after ten idle minutes and takes tens of seconds to come
   * back — longer than the API waits. Focusing the box starts that wake-up, so
   * it happens while the question is being typed instead of after it is sent.
   * Throttled, because a wake lasts about ten minutes and re-poking a live
   * collection only keeps meters running.
   */
  const warmedAt = useRef(0);
  const warm = () => {
    const now = Date.now();
    if (now - warmedAt.current < 5 * 60 * 1000) return;
    warmedAt.current = now;
    void warmSearch().catch(() => {
      // Best effort. Let the question report anything genuinely wrong.
      warmedAt.current = 0;
    });
  };

  const detected: Mode = looksLikePlan(question) ? 'plan' : 'answer';
  const mode: Mode = forcedMode ?? detected;

  const update = (patch: Partial<Turn>) =>
    setTurns((prev) => prev.map((turn, i) => (i === prev.length - 1 ? { ...turn, ...patch } : turn)));

  /** The plan lands on the thread's assistant message, so watch that. */
  async function waitForPlan(id: string, messageAt: string) {
    for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      if (!live.current) return;
      const thread = await getThread(id);
      const message = thread.messages.find((m) => m.created_at === messageAt);
      if (!message || message.status === 'working') continue;

      if (message.status === 'failed') {
        update({ building: false, error: message.error ?? 'the plan could not be built' });
        return;
      }
      update({
        building: false,
        plan: message.plan,
        sources: message.sources,
        unsupported: message.status === 'unsupported',
      });
      return;
    }
    update({ building: false, error: 'the plan is taking longer than expected — try again' });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const asked = question.trim();
    if (!asked || busy) return;

    const asking = mode;
    setQuestion('');
    setForcedMode(undefined);
    setBusy(true);
    setTurns((prev) => [...prev, { question: asked, mode: asking, building: asking === 'plan' }]);

    try {
      if (asking === 'plan') {
        const started = await startPlan(asked, { mediaId, threadId });
        setThreadId(started.threadId);
        await waitForPlan(started.threadId, started.messageAt);
      } else {
        const answer = await ask(asked, { mediaId, threadId });
        setThreadId(answer.threadId ?? undefined);
        update({ answer });
      }
    } catch (err) {
      update({ building: false, error: err instanceof Error ? err.message : 'the question failed' });
    } finally {
      if (live.current) setBusy(false);
    }
  }

  const citationChip = (citation: Citation, sources: Source[] | undefined, key: number) => {
    if (renderCitation) return <span key={key}>{renderCitation(citation)}</span>;
    const source = sources?.find((s) => s.media_id === citation.media_id);
    return (
      <button key={key} className="evidence" onClick={() => onCite?.(citation)}>
        {label ? label(citation) : sourceLabel(source, citation.ts_ms)}
      </button>
    );
  };

  return (
    <section className="ask">
      <h2>Ask</h2>

      {turns.length === 0 && (
        <p className="muted small">
          {mediaId
            ? 'Ask about this reel — "which cafe is shown here?"'
            : 'Ask a question, or ask for something built from everything you have saved — "create me a travel plan for Istanbul with all the tips".'}
        </p>
      )}

      <div className="turns">
        {turns.map((turn, i) => (
          <div key={i} className="turn">
            <p className="question">
              {turn.mode === 'plan' && <span className="mode-tag">Plan</span>}
              {turn.question}
            </p>
            {turn.error && <p className="error small">{turn.error}</p>}

            {turn.building && (
              <p className="muted small">
                Reading across your library and writing it up. This takes about a minute.
              </p>
            )}

            {turn.answer && (
              <>
                <p className={turn.answer.answered ? undefined : 'muted'}>{turn.answer.answer}</p>
                {turn.answer.citations.length > 0 && (
                  <div className="citations">
                    {turn.answer.citations.map((citation, j) =>
                      citationChip(citation, turn.answer?.sources, j),
                    )}
                  </div>
                )}
                {!turn.answer.answered && (
                  <p className="muted small">Not supported by what has been indexed.</p>
                )}
              </>
            )}

            {turn.plan && (
              <article className="plan">
                <h3>{turn.plan.title}</h3>
                <p className="muted">{turn.plan.overview}</p>

                {turn.plan.sections.map((section, s) => (
                  <div key={s} className="plan-section">
                    <h4>{section.heading}</h4>
                    <ul>
                      {section.items.map((item, k) => (
                        <li key={k}>
                          <span>{item.text}</span>
                          <span className="citations">
                            {item.citations.map((citation, j) => citationChip(citation, turn.sources, j))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}

                {turn.unsupported && (
                  <p className="muted small">
                    Nothing in your library covers this, so there is nothing to build from.
                  </p>
                )}

                {turn.plan.gaps.length > 0 && (
                  <div className="plan-gaps">
                    <h4>Your clips don&apos;t cover</h4>
                    <ul>
                      {turn.plan.gaps.map((gap, g) => (
                        <li key={g}>{gap}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {turn.plan.moments !== undefined && (
                  <p className="muted small">
                    Built from {turn.plan.moments} moments across your library.
                    {turn.plan.itemsDropped ? ` ${turn.plan.itemsDropped} unsupported items were dropped.` : ''}
                  </p>
                )}
              </article>
            )}

            {!turn.answer && !turn.plan && !turn.error && !turn.building && (
              <p className="muted small">Thinking…</p>
            )}
          </div>
        ))}
      </div>

      <form className="url-form" onSubmit={submit}>
        <input
          type="text"
          placeholder={mediaId ? 'Ask about this reel…' : 'Ask, or ask for a plan…'}
          value={question}
          onFocus={warm}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={busy}
        />
        <button className="primary" type="submit" disabled={busy || !question.trim()}>
          {mode === 'plan' ? 'Build' : 'Ask'}
        </button>
      </form>

      {question.trim() && (
        <p className="muted small mode-hint">
          {mode === 'plan'
            ? 'Building this from your whole library.'
            : 'Answering from the closest moments.'}{' '}
          <button
            type="button"
            className="linkish"
            onClick={() => setForcedMode(mode === 'plan' ? 'answer' : 'plan')}
          >
            {mode === 'plan' ? 'Just answer it instead' : 'Build it from everything instead'}
          </button>
        </p>
      )}
    </section>
  );
}
