import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from '../routerContext';
import './Parent.css';

interface Child { id: string; name: string; age: number | null }
interface SummaryClaim { concept: string; evidence: string; evidenceIds?: Array<number | string> }
interface Summary {
  headline: string;
  workedOn: string[];
  strengths: SummaryClaim[];
  struggles: (SummaryClaim & { kind: string })[];
  recommendation: string;
  confidenceNote: string;
}
interface SessionRow {
  id: string; goal: string; status: string; startedAt: number; endedAt: number | null; summary: Summary | null;
}
interface EvidenceRow {
  id: number; sessionId: string; ts: number; concept: string; observation: string;
  verdict: 'mastered' | 'progressing' | 'struggling' | 'misconception';
  confidence: 'low' | 'medium' | 'high'; excerpt: string | null; goal: string;
}
interface Overview { child: Child; sessions: SessionRow[]; evidence: EvidenceRow[] }
interface EventRow { id: number; ts: number; type: string; payload: { text?: string; concept?: string; verdict?: string; activeConcept?: string } }
interface TimelineState { status: 'loading' | 'ready' | 'error'; events: EventRow[] }

const SELECTED_CHILD_KEY = 'noura.selectedChildId';

function formatWhen(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function statusFor(entry: EvidenceRow): { label: string; tone: string } {
  if (entry.verdict === 'mastered') return { label: 'Demonstrated', tone: 'demonstrated' };
  if (entry.verdict === 'misconception' || entry.verdict === 'struggling') return { label: 'Misunderstood', tone: 'misunderstood' };
  return { label: 'Uncertain', tone: 'uncertain' };
}

export function ParentPage() {
  const { navigate } = useRouter();
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const requestedSession = query.get('session');
  const [children, setChildren] = useState<Child[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(requestedSession);
  const [timelines, setTimelines] = useState<Record<string, TimelineState>>({});

  const loadOverview = useCallback(async (childId: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/children/${encodeURIComponent(childId)}/overview`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as Overview;
      setOverview(body);
      setSelectedId(body.child.id);
      window.localStorage.setItem(SELECTED_CHILD_KEY, body.child.id);
    } catch {
      setOverview(null);
      setError('Noura could not load this learner’s Parent Area.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const childrenResponse = await fetch('/api/children');
        if (!childrenResponse.ok) throw new Error('children unavailable');
        const childRows = ((await childrenResponse.json()) as { children: Child[] }).children;
        if (cancelled) return;
        setChildren(childRows);

        let childId = query.get('selectedChildId') ?? window.localStorage.getItem(SELECTED_CHILD_KEY);
        if (requestedSession) {
          const sessionResponse = await fetch(`/api/sessions/${encodeURIComponent(requestedSession)}`);
          if (!sessionResponse.ok) throw new Error('session unavailable');
          childId = ((await sessionResponse.json()) as { session: { childId: string } }).session.childId;
        }
        if (!childId) {
          setLoading(false);
          setError(childRows.length ? 'Choose a learner to open their Parent Area.' : 'No learners yet. Create one from Parent setup.');
          return;
        }
        if (!childRows.some((child) => child.id === childId)) {
          setLoading(false);
          setError('That learner is not available. Choose another learner.');
          return;
        }
        await loadOverview(childId);
      } catch {
        if (!cancelled) {
          setLoading(false);
          setError('Noura could not load the Parent Area.');
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [loadOverview, query, requestedSession]);

  const loadTimeline = useCallback(async (sessionId: string) => {
    setTimelines((current) => ({ ...current, [sessionId]: { status: 'loading', events: current[sessionId]?.events ?? [] } }));
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { events: EventRow[] };
      setTimelines((current) => ({ ...current, [sessionId]: { status: 'ready', events: body.events } }));
    } catch {
      setTimelines((current) => ({ ...current, [sessionId]: { status: 'error', events: [] } }));
    }
  }, []);

  useEffect(() => {
    if (requestedSession && !timelines[requestedSession]) void loadTimeline(requestedSession);
  }, [requestedSession, timelines, loadTimeline]);

  const chooseLearner = useCallback((childId: string) => {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('selectedChildId', childId);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    setOpenSession(null);
    setTimelines({});
    void loadOverview(childId);
  }, [loadOverview]);

  const toggleTimeline = useCallback((sessionId: string) => {
    setOpenSession((current) => current === sessionId ? null : sessionId);
    if (!timelines[sessionId]) void loadTimeline(sessionId);
  }, [loadTimeline, timelines]);

  const home = () => navigate(selectedId ? `/?selectedChildId=${encodeURIComponent(selectedId)}` : '/');

  if (loading) return <main className="parent parent--empty" id="main-content" aria-live="polite"><p>Loading Parent Area…</p></main>;
  if (!overview) {
    return (
      <main className="parent parent--empty" id="main-content">
        <div className="parent__empty-card">
          <p>{error}</p>
          {children.length > 0 && (
            <label className="parent__switch-label">Choose learner
              <select value="" onChange={(event) => event.target.value && chooseLearner(event.target.value)}>
                <option value="">Select…</option>
                {children.map((child) => <option key={child.id} value={child.id}>{child.name}</option>)}
              </select>
            </label>
          )}
          <button className="parent__link" onClick={home}>Back to Parent setup</button>
        </div>
      </main>
    );
  }

  const { child, sessions, evidence } = overview;
  const latestWithSummary = sessions.find((session) => session.summary);
  const grouped = new Map<string, EvidenceRow[]>();
  for (const entry of evidence) grouped.set(entry.concept, [...(grouped.get(entry.concept) ?? []), entry]);
  const concepts = [...grouped.entries()].map(([concept, history]) => ({ concept, latest: history[0], history }));

  return (
    <main className="parent" id="main-content">
      <div className="parent__page">
        <header className="parent__head">
          <div className="parent__head-row">
            <button className="parent__link" onClick={home}>← Parent setup</button>
            <label className="parent__switch-label">Learner
              <select value={child.id} onChange={(event) => chooseLearner(event.target.value)}>
                {children.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
              </select>
            </label>
          </div>
          <p className="parent__eyebrow">Noura · Parent Area</p>
          <h1>{child.name}{child.age ? <span className="parent__age"> · age {child.age}</span> : null}</h1>
          <p className="parent__sub">{sessions.length === 0 ? 'No lessons yet.' : `${sessions.length} lesson${sessions.length === 1 ? '' : 's'} · ${evidence.length} evidence observation${evidence.length === 1 ? '' : 's'}`}</p>
        </header>

        {latestWithSummary?.summary ? (
          <section className="parent__card parent__card--headline" aria-labelledby="latest-title">
            <h2 id="latest-title">Latest session</h2>
            <p className="parent__headline">{latestWithSummary.summary.headline}</p>
            {latestWithSummary.summary.workedOn.length > 0 && <div className="parent__chips">{latestWithSummary.summary.workedOn.map((item) => <span key={item} className="parent__chip">{item}</span>)}</div>}
            <div className="parent__columns">
              <SummaryColumn title="Demonstrated" claims={latestWithSummary.summary.strengths} tone="demonstrated" />
              <SummaryColumn title="Uncertain or misunderstood" claims={latestWithSummary.summary.struggles} tone="misunderstood" />
            </div>
            <div className="parent__recommendation">
              <h3>Recommended next action</h3>
              <p>{latestWithSummary.summary.recommendation}</p>
              <p className="parent__confidence">{latestWithSummary.summary.confidenceNote}</p>
            </div>
          </section>
        ) : (
          <section className="parent__card"><h2>Next action</h2><p className="parent__headline">Start a lesson to create the first evidence-backed update.</p><button className="parent__primary" onClick={home}>Set up a lesson</button></section>
        )}

        <section className="parent__card" aria-labelledby="concepts-title">
          <h2 id="concepts-title">Concept history</h2>
          <p className="parent__note">Observations stay in order so difficulty, contradiction, and later improvement remain visible. These are not scores.</p>
          {concepts.length === 0 ? <p className="parent__note">No meaningful learner evidence has been recorded yet.</p> : (
            <ul className="parent__concepts">
              {concepts.map(({ concept, latest, history }) => {
                const status = statusFor(latest);
                const contradictory = new Set(history.map((entry) => entry.verdict)).size > 1;
                return (
                  <li key={concept}>
                    <span className={`parent__verdict parent__verdict--${status.tone}`}>{status.label}</span>
                    <div>
                      <p className="parent__concept-name">{concept}</p>
                      <p className="parent__concept-obs">{latest.observation}{latest.excerpt ? <em> — “{latest.excerpt}”</em> : null}</p>
                      <p className="parent__concept-meta">Evidence #{latest.id} · {latest.confidence} confidence · {formatWhen(latest.ts)}{contradictory ? ' · Earlier evidence differs' : ''}</p>
                      {history.length > 1 && <details className="parent__history"><summary>View {history.length - 1} earlier observation{history.length === 2 ? '' : 's'}</summary>{history.slice(1).map((entry) => <p key={entry.id}><strong>#{entry.id}</strong> · {formatWhen(entry.ts)} — {entry.observation}</p>)}</details>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="parent__card" aria-labelledby="sessions-title">
          <h2 id="sessions-title">Sessions and evidence timeline</h2>
          {sessions.length === 0 && <p className="parent__note">No sessions yet.</p>}
          {sessions.map((session) => {
            const timeline = timelines[session.id];
            return (
              <div key={session.id} className="parent__session">
                <button className="parent__session-row" onClick={() => toggleTimeline(session.id)} aria-expanded={openSession === session.id}>
                  <span className="parent__session-goal">{session.goal}</span>
                  <span className="parent__session-when">{formatWhen(session.startedAt)}{session.status === 'active' ? ' · in progress' : ''}</span>
                  <span className="parent__session-toggle">{openSession === session.id ? 'Hide' : 'Details'}</span>
                </button>
                {openSession === session.id && (
                  <div className="parent__timeline" tabIndex={-1}>
                    {timeline?.status === 'loading' && <p className="parent__note">Loading transcript…</p>}
                    {timeline?.status === 'error' && <p className="parent__timeline-error">Timeline could not load. <button onClick={() => void loadTimeline(session.id)}>Try again</button></p>}
                    {timeline?.status === 'ready' && timeline.events.map((event) => <TimelineEvent key={event.id} event={event} childName={child.name} />)}
                    {timeline?.status === 'ready' && timeline.events.length === 0 && <p className="parent__note">This session recorded no conversation.</p>}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>
    </main>
  );
}

function SummaryColumn({ title, claims, tone }: { title: string; claims: SummaryClaim[]; tone: string }) {
  if (claims.length === 0) return <div><h3>{title}</h3><p className="parent__note">Not enough evidence in this session.</p></div>;
  return <div><h3>{title}</h3>{claims.map((claim) => <p key={claim.concept} className="parent__evidence-line"><strong>{claim.concept}.</strong> {claim.evidence}{claim.evidenceIds?.length ? <span className={`parent__claim-source parent__claim-source--${tone}`}>Evidence {claim.evidenceIds.map((id) => `#${id}`).join(', ')}</span> : null}</p>)}</div>;
}

function TimelineEvent({ event, childName }: { event: EventRow; childName: string }) {
  if (event.type === 'tutor_said') return <p className="parent__line parent__line--tutor"><strong>Noura:</strong> {event.payload.text}</p>;
  if (event.type === 'learner_said') return <p className="parent__line parent__line--child"><strong>{childName}:</strong> {event.payload.text}</p>;
  if (event.type === 'interrupted') return <p className="parent__line parent__line--marker">{childName} interrupted</p>;
  if (event.type === 'evidence') return <p className="parent__line parent__line--marker">Evidence noted: {event.payload.concept} ({event.payload.verdict})</p>;
  if (event.type === 'lesson_state' && event.payload.activeConcept) return <p className="parent__line parent__line--marker">Focus → {event.payload.activeConcept}</p>;
  return null;
}
