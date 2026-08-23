import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from '../routerContext';
import './Home.css';

interface ChildRow {
  id: string;
  name: string;
  age: number | null;
  sessionCount: number;
  lastSession: { id: string; goal: string; startedAt: number; status: string } | null;
}

interface AppConfig {
  realtime: boolean;
  lessonsAvailable: boolean;
  durableStorage: boolean;
  deploymentMode: string;
  syntheticOnly: boolean;
}

const SELECTED_CHILD_KEY = 'noura.selectedChildId';
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
  const requestedChildId = useMemo(
    () => new URLSearchParams(window.location.search).get('selectedChildId'),
    [],
  );
  const [children, setChildren] = useState<ChildRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [newName, setNewName] = useState('');
  const [newAge, setNewAge] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [ageError, setAgeError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);

  const chooseChild = useCallback((childId: string | null) => {
    setSelectedId(childId);
    const url = new URL(window.location.href);
    if (childId) {
      url.searchParams.set('selectedChildId', childId);
      window.localStorage.setItem(SELECTED_CHILD_KEY, childId);
    } else {
      url.searchParams.delete('selectedChildId');
      window.localStorage.removeItem(SELECTED_CHILD_KEY);
    }
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, []);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await fetch('/api/children');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { children: ChildRow[] };
      setChildren(body.children);

      const stored = window.localStorage.getItem(SELECTED_CHILD_KEY);
      const candidate = requestedChildId ?? stored;
      if (candidate && body.children.some((child) => child.id === candidate)) {
        chooseChild(candidate);
      } else if (requestedChildId) {
        chooseChild(null);
        setActionError('That learner is not available. Choose a learner to continue.');
      } else if (candidate) {
        chooseChild(null);
      }
    } catch {
      setLoadError('Noura could not reach the local lesson service.');
      setChildren([]);
    }
  }, [chooseChild, requestedChildId]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/api/config');
        if (!response.ok) throw new Error('configuration unavailable');
        setConfig(await response.json() as AppConfig);
      } catch {
        setConfig({ realtime: false, lessonsAvailable: false, durableStorage: false, deploymentMode: 'unavailable', syntheticOnly: true });
      }
      // In public v0, /api/config establishes the signed guest-parent cookie.
      // Load parent-scoped data only after that boundary is stable.
      await refresh();
    })();
  }, [refresh]);

  const createLearner = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (creating || !config?.lessonsAvailable) return;
      const name = newName.trim();
      const age = Number(newAge);
      const nextNameError = name ? null : 'Enter the learner’s name.';
      const nextAgeError = Number.isInteger(age) && age >= 3 && age <= 18
        ? null
        : 'Enter an age from 3 to 18.';
      setNameError(nextNameError);
      setAgeError(nextAgeError);
      if (nextNameError || nextAgeError) return;

      setCreating(true);
      setActionError(null);
      try {
        const response = await fetch('/api/children', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, age }),
        });
        const body = (await response.json()) as { child?: { id: string }; error?: string };
        if (!response.ok || !body.child) throw new Error(body.error ?? 'failed');
        setNewName('');
        setNewAge('');
        await refresh();
        chooseChild(body.child.id);
      } catch {
        setActionError('Noura could not create that learner. Try again.');
      } finally {
        setCreating(false);
      }
    },
    [creating, config?.lessonsAvailable, newAge, newName, refresh, chooseChild],
  );

  const start = useCallback(async () => {
    if (!selectedId || !goal.trim() || starting || !config?.lessonsAvailable) return;
    setStarting(true);
    setActionError(null);
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childId: selectedId, goal: goal.trim() }),
      });
      const body = (await response.json()) as { session?: { id: string }; lessonCapability?: string; error?: string };
      if (!response.ok || !body.session) throw new Error(body.error ?? 'failed');
      if (body.lessonCapability) window.sessionStorage.setItem(`noura.lessonCapability.${body.session.id}`, body.lessonCapability);
      navigate(`/lesson/${body.session.id}?selectedChildId=${encodeURIComponent(selectedId)}`);
    } catch {
      setActionError('Noura could not start the lesson. Try again.');
      setStarting(false);
    }
  }, [selectedId, goal, starting, config?.lessonsAvailable, navigate]);

  const selected = children?.find((child) => child.id === selectedId) ?? null;
  const firstUse = children?.length === 0;

  return (
    <main className="home" id="main-content">
      <div className="home__card">
        <header className="home__head">
          <NouraMark />
          <div>
            <p className="home__eyebrow">A shared teaching board</p>
            <h1>Noura</h1>
            <p>A tutor that talks through ideas and draws while your child learns.</p>
          </div>
        </header>

        {config?.syntheticOnly && (
          <p className="home__boundary" role="note">
            {config.deploymentMode === 'production-v0'
              ? 'Live MVP preview · use pretend learner details only.'
              : 'Private prototype · use synthetic learner details only.'}
          </p>
        )}
        {config && !config.lessonsAvailable && (
          <div className="home__warning" role="alert">
            <strong>Interactive lessons are unavailable here.</strong>{' '}
            {config.deploymentMode === 'preview-synthetic'
              ? 'This protected Preview has no shared durable store, so it is limited to synthetic interface and visual-fixture review.'
              : 'The provider or durable lesson service is not configured.'}
          </div>
        )}
        {loadError && (
          <div className="home__warning" role="alert">
            {loadError} <button onClick={() => void refresh()}>Try again</button>
          </div>
        )}
        {actionError && <p className="home__warning" role="alert">{actionError}</p>}

        {children === null ? (
          <section className="home__loading" aria-live="polite">
            <span className="home__spinner" aria-hidden="true" /> Loading parent setup…
          </section>
        ) : firstUse ? (
          <section className="home__section home__setup" aria-labelledby="parent-setup-title">
            <div className="home__section-head">
              <p className="home__step">Parent setup</p>
              <h2 id="parent-setup-title">Create a learner</h2>
              <p>Add only the details Noura needs to pitch explanations at the right level.</p>
            </div>
            <LearnerForm
              name={newName}
              age={newAge}
              nameError={nameError}
              ageError={ageError}
              creating={creating}
              disabled={!config?.lessonsAvailable}
              onName={setNewName}
              onAge={setNewAge}
              onSubmit={createLearner}
            />
            <p className="home__disclosure">
              Noura is AI. A parent should choose the lesson goal and review the session afterwards. Voice and lesson text are sent to the configured AI provider; raw audio is not stored by Noura.
            </p>
          </section>
        ) : (
          <>
            <section className="home__section" aria-labelledby="learner-title">
              <div className="home__section-head home__section-head--row">
                <div>
                  <p className="home__step">Parent setup</p>
                  <h2 id="learner-title">Choose the learner</h2>
                </div>
                {selected && (
                  <button className="home__parent" onClick={() => navigate(`/parent?selectedChildId=${selected.id}`)}>
                    Open Parent Area
                  </button>
                )}
              </div>
              <div className="home__children" aria-label="Learners">
                {children.map((child) => (
                  <button
                    key={child.id}
                    className="home__child"
                    aria-pressed={selectedId === child.id}
                    onClick={() => chooseChild(child.id)}
                  >
                    <span className="home__child-name">{child.name}</span>
                    <span className="home__child-meta">
                      {child.age ? `Age ${child.age} · ` : ''}
                      {child.sessionCount === 0 ? 'First lesson' : `${child.sessionCount} lesson${child.sessionCount === 1 ? '' : 's'}`}
                    </span>
                  </button>
                ))}
              </div>
              <details className="home__add-more">
                <summary>Add another learner</summary>
                <LearnerForm
                  name={newName}
                  age={newAge}
                  nameError={nameError}
                  ageError={ageError}
                  creating={creating}
                  disabled={!config?.lessonsAvailable}
                  onName={setNewName}
                  onAge={setNewAge}
                  onSubmit={createLearner}
                />
              </details>
            </section>

            {selected ? (
              <section className="home__section home__handoff" aria-labelledby="goal-title">
                <div className="home__selected">
                  <span className="home__selected-dot" aria-hidden="true" />
                  <div>
                    <span>Setting up for</span>
                    <strong>{selected.name}</strong>
                  </div>
                </div>
                <label className="home__label" htmlFor="lesson-goal" id="goal-title">What should Noura help with?</label>
                <input
                  id="lesson-goal"
                  className="home__goal"
                  value={goal}
                  onChange={(event) => setGoal(event.target.value)}
                  placeholder="A question, a topic, or something from school…"
                  maxLength={200}
                  data-testid="goal-input"
                />
                <div className="home__ideas" aria-label="Lesson goal suggestions">
                  {GOAL_IDEAS.map((idea) => (
                    <button key={idea} className="home__idea" onClick={() => setGoal(idea)}>{idea}</button>
                  ))}
                </div>
                <div className="home__foot">
                  <p>Next, hand the device to {selected.name}. They’ll tap Begin to allow sound and choose microphone access.</p>
                  <button
                    className="home__start"
                    onClick={start}
                    disabled={!goal.trim() || starting || !config?.lessonsAvailable}
                    data-testid="start-session"
                  >
                    {starting ? 'Preparing the board…' : `Hand to ${selected.name}`}
                  </button>
                </div>
              </section>
            ) : (
              <p className="home__empty">Choose a learner before setting a lesson goal.</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function LearnerForm(props: {
  name: string;
  age: string;
  nameError: string | null;
  ageError: string | null;
  creating: boolean;
  disabled: boolean;
  onName: (value: string) => void;
  onAge: (value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <form className="home__add" onSubmit={props.onSubmit} noValidate>
      <div className="home__field">
        <label htmlFor="learner-name">Name</label>
        <input
          id="learner-name"
          value={props.name}
          onChange={(event) => props.onName(event.target.value)}
          autoComplete="off"
          maxLength={40}
          aria-invalid={Boolean(props.nameError)}
          aria-describedby={props.nameError ? 'learner-name-error' : undefined}
        />
        {props.nameError && <span id="learner-name-error" className="home__field-error">{props.nameError}</span>}
      </div>
      <div className="home__field home__field--age">
        <label htmlFor="learner-age">Age</label>
        <input
          id="learner-age"
          value={props.age}
          onChange={(event) => props.onAge(event.target.value.replace(/\D/g, '').slice(0, 2))}
          inputMode="numeric"
          aria-invalid={Boolean(props.ageError)}
          aria-describedby={props.ageError ? 'learner-age-error' : 'learner-age-help'}
        />
        {props.ageError ? (
          <span id="learner-age-error" className="home__field-error">{props.ageError}</span>
        ) : (
          <span id="learner-age-help" className="home__field-help">Used only to adjust explanations.</span>
        )}
      </div>
      <button type="submit" disabled={props.creating || props.disabled}>
        {props.creating ? 'Creating…' : 'Create learner'}
      </button>
    </form>
  );
}

function NouraMark() {
  return (
    <svg className="home__logo" viewBox="0 0 54 54" role="img" aria-label="Noura">
      <g transform="translate(-347,-252)">
        <path d="M348 296 c0 -25, 12 -41, 26 -41 s26 16, 26 41 c0 7 -6 9 -26 9 s-26 -2 -26 -9z" fill="var(--blue)" />
        <circle cx="366" cy="269" r="3.1" fill="var(--board)" />
        <circle cx="382" cy="269" r="3.1" fill="var(--board)" />
        <path d="M367 280 c3 3, 9 3, 12 0" stroke="var(--board)" strokeWidth="2.2" strokeLinecap="round" fill="none" />
      </g>
    </svg>
  );
}
