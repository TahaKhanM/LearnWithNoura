import { useCallback, useEffect, useState } from 'react';
import { useRouter } from '../router';
import './Home.css';

interface ChildRow {
  id: string;
  name: string;
  age: number | null;
  sessionCount: number;
  lastSession: { id: string; goal: string; startedAt: number; status: string } | null;
}

const GOAL_IDEAS = [
  'Why triangle angles always add up to 180°',
  'How fractions on a number line work',
  'What makes the water cycle go around',
  'Reading a simple line graph',
  'Why the Nile mattered to Ancient Egypt',
  'What negative numbers actually mean',
];

export function HomePage() {
  const { navigate } = useRouter();
  const [children, setChildren] = useState<ChildRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [newName, setNewName] = useState('');
  const [newAge, setNewAge] = useState('');
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/children');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { children: ChildRow[] };
      setChildren(body.children);
      if (body.children.length > 0) {
        setSelected((current) => current ?? body.children[0].id);
      }
    } catch {
      setError('The Seneca backend is not reachable. Is `npm run dev` running?');
      setChildren([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : { realtime: true }))
      .then((body: { realtime?: boolean }) => setConfigured(body.realtime !== false))
      .catch(() => undefined);
  }, [refresh]);

  const addChild = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!newName.trim()) return;
      setAdding(true);
      try {
        const response = await fetch('/api/children', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: newName.trim(),
            ...(newAge ? { age: Number(newAge) } : {}),
          }),
        });
        const body = (await response.json()) as { child?: { id: string }; error?: string };
        if (!response.ok || !body.child) throw new Error(body.error ?? 'failed');
        setNewName('');
        setNewAge('');
        await refresh();
        setSelected(body.child.id);
      } catch {
        setError('Could not add that learner.');
      } finally {
        setAdding(false);
      }
    },
    [newName, newAge, refresh],
  );

  const start = useCallback(async () => {
    if (!selected || !goal.trim() || starting) return;
    setStarting(true);
    setError(null);
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childId: selected, goal: goal.trim() }),
      });
      const body = (await response.json()) as { session?: { id: string }; error?: string };
      if (!response.ok || !body.session) throw new Error(body.error ?? 'failed');
      navigate(`/lesson/${body.session.id}`);
    } catch {
      setError('Could not start the lesson.');
      setStarting(false);
    }
  }, [selected, goal, starting, navigate]);

  return (
    <div className="home">
      <div className="home__card">
        <header className="home__head">
          <svg className="home__logo" viewBox="0 0 54 54" aria-hidden="true">
            <g transform="translate(-347,-252)">
              <path d="M348 296 c0 -25, 12 -41, 26 -41 s26 16, 26 41 c0 7 -6 9 -26 9 s-26 -2 -26 -9z" fill="var(--blue)" />
              <circle cx="366" cy="269" r="3.1" fill="var(--board)" />
              <circle cx="382" cy="269" r="3.1" fill="var(--board)" />
              <path d="M367 280 c3 3, 9 3, 12 0" stroke="var(--board)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
            </g>
          </svg>
          <div>
            <h1>Seneca</h1>
            <p>A tutor that talks with your child and draws while it teaches.</p>
          </div>
        </header>

        {!configured && (
          <p className="home__warning">
            No OPENAI_API_KEY is configured on the server, so lessons cannot run.
            Add it to <code>.env</code> and restart.
          </p>
        )}
        {error && <p className="home__warning">{error}</p>}

        <section className="home__section">
          <h2>Who is learning today?</h2>
          <div className="home__children">
            {children === null && <p className="home__muted">Loading…</p>}
            {children?.map((child) => (
              <button
                key={child.id}
                className="home__child"
                aria-pressed={selected === child.id}
                onClick={() => setSelected(child.id)}
              >
                <span className="home__child-name">{child.name}</span>
                <span className="home__child-meta">
                  {child.age ? `age ${child.age} · ` : ''}
                  {child.sessionCount === 0
                    ? 'first lesson'
                    : `${child.sessionCount} lesson${child.sessionCount === 1 ? '' : 's'}`}
                </span>
              </button>
            ))}
            <form className="home__add" onSubmit={addChild}>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Add a learner…"
                aria-label="New learner name"
                maxLength={40}
              />
              <input
                value={newAge}
                onChange={(e) => setNewAge(e.target.value.replace(/\D/g, '').slice(0, 2))}
                placeholder="Age"
                aria-label="Age"
                inputMode="numeric"
                className="home__age"
              />
              <button type="submit" disabled={!newName.trim() || adding}>Add</button>
            </form>
          </div>
        </section>

        <section className="home__section">
          <h2>What should Seneca teach?</h2>
          <input
            className="home__goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Anything — a question, a topic, a struggle from school…"
            maxLength={200}
            data-testid="goal-input"
          />
          <div className="home__ideas">
            {GOAL_IDEAS.map((idea) => (
              <button key={idea} className="home__idea" onClick={() => setGoal(idea)}>
                {idea}
              </button>
            ))}
          </div>
        </section>

        <footer className="home__foot">
          <button
            className="home__parent"
            onClick={() => selected && navigate(`/parent?child=${selected}`)}
            disabled={!selected}
          >
            Parent dashboard
          </button>
          <button
            className="home__start"
            onClick={start}
            disabled={!selected || !goal.trim() || starting || !configured}
            data-testid="start-session"
          >
            {starting ? 'Setting up…' : 'Start lesson'}
          </button>
        </footer>
      </div>
    </div>
  );
}
