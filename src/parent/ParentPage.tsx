import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from '../router';
import './Parent.css';

interface Child {
  id: string;
  name: string;
  age: number | null;
}

interface Summary {
  headline: string;
  workedOn: string[];
  strengths: { concept: string; evidence: string }[];
  struggles: { concept: string; evidence: string; kind: string }[];
  recommendation: string;
  confidenceNote: string;
}

interface SessionRow {
  id: string;
  goal: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  summary: Summary | null;
}

interface EvidenceRow {
  id: number;
  sessionId: string;
  ts: number;
  concept: string;
  observation: string;
  verdict: 'mastered' | 'progressing' | 'struggling' | 'misconception';
  confidence: 'low' | 'medium' | 'high';
  excerpt: string | null;
}

interface Overview {
  child: Child;
  sessions: SessionRow[];
  evidence: (EvidenceRow & { goal: string })[];
}

interface EventRow {
  id: number;
  ts: number;
  type: string;
  payload: { text?: string; concept?: string; verdict?: string; activeConcept?: string };
}

const VERDICT_LABEL: Record<EvidenceRow['verdict'], string> = {
  mastered: 'Solid',
  progressing: 'Getting there',
  struggling: 'Struggled',
  misconception: 'Misconception',
};

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ParentPage() {
  const { navigate } = useRouter();
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(query.get('session'));
  const [timeline, setTimeline] = useState<Record<string, EventRow[]>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        let childId = query.get('child');
        if (!childId) {
          const sessionId = query.get('session');
          if (sessionId) {
            const r = await fetch(`/api/sessions/${sessionId}`);
            if (r.ok) childId = ((await r.json()) as { session: { childId: string } }).session.childId;
          }
        }
        if (!childId) {
          const r = await fetch('/api/children');
          const body = (await r.json()) as { children: Child[] };
          childId = body.children[0]?.id ?? null;
        }
        if (!childId) {
          if (!cancelled) setError('No learners yet — start a first lesson.');
          return;
        }
        const r = await fetch(`/api/children/${childId}/overview`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as Overview;
        if (!cancelled) setOverview(body);
      } catch {
        if (!cancelled) setError('Could not load the dashboard.');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [query]);

  const toggleTimeline = useCallback(
    async (sessionId: string) => {
      setOpenSession((current) => (current === sessionId ? null : sessionId));
      if (!timeline[sessionId]) {
        try {
          const r = await fetch(`/api/sessions/${sessionId}`);
          if (r.ok) {
            const body = (await r.json()) as { events: EventRow[] };
            setTimeline((current) => ({ ...current, [sessionId]: body.events }));
          }
        } catch {
          /* the summary is still shown without the drill-down */
        }
      }
    },
    [timeline],
  );

  if (error) {
    return (
      <div className="parent parent--empty">
        <p>{error}</p>
        <button className="parent__link" onClick={() => navigate('/')}>Back home</button>
      </div>
    );
  }

  if (!overview) {
    return <div className="parent parent--empty"><p>Loading…</p></div>;
  }

  const { child, sessions, evidence } = overview;
  const latestWithSummary = sessions.find((s) => s.summary);

  // The latest verdict per concept, most recent first. No invented scores —
  // just what was last observed, with its evidence a click away below.
  const conceptMap = new Map<string, EvidenceRow & { goal: string }>();
  for (const entry of evidence) {
    if (!conceptMap.has(entry.concept)) conceptMap.set(entry.concept, entry);
  }
  const concepts = [...conceptMap.values()];

  return (
    <div className="parent">
      <div className="parent__page">
        <header className="parent__head">
          <button className="parent__link" onClick={() => navigate('/')}>← Home</button>
          <h1>
            {child.name}
            {child.age ? <span className="parent__age"> · age {child.age}</span> : null}
          </h1>
          <p className="parent__sub">
            {sessions.length === 0
              ? 'No lessons yet.'
              : `${sessions.length} lesson${sessions.length === 1 ? '' : 's'} · ${evidence.length} recorded observation${evidence.length === 1 ? '' : 's'}`}
          </p>
        </header>

        {latestWithSummary?.summary && (
          <section className="parent__card parent__card--headline">
            <h2>Latest session</h2>
            <p className="parent__headline">{latestWithSummary.summary.headline}</p>
            {latestWithSummary.summary.workedOn.length > 0 && (
              <div className="parent__chips">
                {latestWithSummary.summary.workedOn.map((item) => (
                  <span key={item} className="parent__chip">{item}</span>
                ))}
              </div>
            )}
            <div className="parent__columns">
              {latestWithSummary.summary.strengths.length > 0 && (
                <div>
                  <h3>Went well</h3>
                  {latestWithSummary.summary.strengths.map((s) => (
                    <p key={s.concept} className="parent__evidence-line">
                      <strong>{s.concept}.</strong> {s.evidence}
                    </p>
                  ))}
                </div>
              )}
              {latestWithSummary.summary.struggles.length > 0 && (
                <div>
                  <h3>Needs attention</h3>
                  {latestWithSummary.summary.struggles.map((s) => (
                    <p key={s.concept} className="parent__evidence-line">
                      <strong>{s.concept}</strong>
                      <span className={`parent__kind parent__kind--${s.kind}`}>{s.kind}</span>
                      <br />
                      {s.evidence}
                    </p>
                  ))}
                </div>
              )}
            </div>
            <div className="parent__recommendation">
              <h3>Next step</h3>
              <p>{latestWithSummary.summary.recommendation}</p>
              <p className="parent__confidence">{latestWithSummary.summary.confidenceNote}</p>
            </div>
          </section>
        )}

        {concepts.length > 0 && (
          <section className="parent__card">
            <h2>Concepts so far</h2>
            <p className="parent__note">The most recent observation for each concept — not a score.</p>
            <ul className="parent__concepts">
              {concepts.map((entry) => (
                <li key={entry.concept}>
                  <span className={`parent__verdict parent__verdict--${entry.verdict}`}>
                    {VERDICT_LABEL[entry.verdict]}
                  </span>
                  <div>
                    <p className="parent__concept-name">{entry.concept}</p>
                    <p className="parent__concept-obs">
                      {entry.observation}
                      {entry.excerpt ? <em> — “{entry.excerpt}”</em> : null}
                    </p>
                    <p className="parent__concept-meta">
                      {entry.confidence} confidence · {formatWhen(entry.ts)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="parent__card">
          <h2>Sessions</h2>
          {sessions.length === 0 && <p className="parent__note">Nothing here yet.</p>}
          {sessions.map((session) => (
            <div key={session.id} className="parent__session">
              <button className="parent__session-row" onClick={() => toggleTimeline(session.id)}>
                <span className="parent__session-goal">{session.goal}</span>
                <span className="parent__session-when">
                  {formatWhen(session.startedAt)}
                  {session.status === 'active' ? ' · in progress' : ''}
                </span>
                <span className="parent__session-toggle">
                  {openSession === session.id ? 'Hide' : 'Details'}
                </span>
              </button>
              {openSession === session.id && (
                <div className="parent__timeline">
                  {session.summary && session.id !== latestWithSummary?.id && (
                    <p className="parent__headline parent__headline--small">
                      {session.summary.headline}
                    </p>
                  )}
                  {(timeline[session.id] ?? []).map((event) => (
                    <TimelineEvent key={event.id} event={event} childName={child.name} />
                  ))}
                  {!timeline[session.id] && <p className="parent__note">Loading transcript…</p>}
                  {timeline[session.id]?.length === 0 && (
                    <p className="parent__note">This session recorded no conversation.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function TimelineEvent({ event, childName }: { event: EventRow; childName: string }) {
  switch (event.type) {
    case 'tutor_said':
      return <p className="parent__line parent__line--tutor">{event.payload.text}</p>;
    case 'learner_said':
      return (
        <p className="parent__line parent__line--child">
          <strong>{childName}:</strong> {event.payload.text}
        </p>
      );
    case 'interrupted':
      return <p className="parent__line parent__line--marker">{childName} interrupted</p>;
    case 'evidence':
      return (
        <p className="parent__line parent__line--marker">
          noted: {event.payload.concept} ({event.payload.verdict})
        </p>
      );
    case 'lesson_state':
      return event.payload.activeConcept ? (
        <p className="parent__line parent__line--marker">
          focus → {event.payload.activeConcept}
        </p>
      ) : null;
    default:
      return null;
  }
}
