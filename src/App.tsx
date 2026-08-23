import { lazy, Suspense } from 'react';
import { RouterProvider } from './router';
import { useRouter } from './routerContext';
import { matchPath } from './matchPath';
import './App.css';

const HomePage = lazy(() => import('./home/HomePage').then((module) => ({ default: module.HomePage })));
const LessonPage = lazy(() => import('./lesson/LessonPage').then((module) => ({ default: module.LessonPage })));
const ParentPage = lazy(() => import('./parent/ParentPage').then((module) => ({ default: module.ParentPage })));
const BoardHarness = lazy(() => import('./dev/BoardHarness').then((module) => ({ default: module.BoardHarness })));

function Routes() {
  const { path } = useRouter();

  const lesson = matchPath('/lesson/:id', path);
  if (lesson) return <LessonPage key={lesson.id} sessionId={lesson.id} />;
  if (path === '/parent') return <ParentPage />;
  if (path === '/dev/board') return <BoardHarness />;
  return <HomePage />;
}

function App() {
  return (
    <RouterProvider>
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <Suspense fallback={<main id="main-content" className="route-loading" aria-live="polite">Loading Noura…</main>}>
        <Routes />
      </Suspense>
    </RouterProvider>
  );
}

export default App;
