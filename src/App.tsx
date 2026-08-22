import { RouterProvider, matchPath, useRouter } from './router';
import { HomePage } from './home/HomePage';
import { LessonPage } from './lesson/LessonPage';
import { ParentPage } from './parent/ParentPage';
import { BoardHarness } from './dev/BoardHarness';
import './App.css';

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
      <Routes />
    </RouterProvider>
  );
}

export default App;
