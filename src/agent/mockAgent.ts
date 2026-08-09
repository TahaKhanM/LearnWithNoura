import { DrawLine, drawEllipse, writeText, chat } from '../whiteboard/types';
import type { LessonStep } from '../whiteboard/types';

const FALLBACK_TOPICS = ['the pythagorean theorem', 'slope of a line', 'area of a circle'];

function pythagoreanLesson(): LessonStep[] {
  return [
    chat("Let's look at the Pythagorean theorem using a right triangle."),
    writeText('Pythagorean Theorem', 300, 80, { fontSize: 26 }),
    chat('First, the two legs that meet at a right angle.'),
    DrawLine(200, 450, 500, 450),
    DrawLine(200, 450, 200, 200),
    writeText('a', 340, 480),
    writeText('b', 165, 330),
    chat('Now the hypotenuse connecting their far ends.'),
    DrawLine(500, 450, 200, 200),
    writeText('c', 380, 300),
    chat('The relationship between them is: a² + b² = c²'),
    writeText('a² + b² = c²', 280, 550, { fontSize: 22, color: '#2563eb' }),
  ];
}

function slopeLesson(): LessonStep[] {
  return [
    chat("Let's talk about slope, the steepness of a line."),
    writeText('Slope of a Line', 350, 60, { fontSize: 26 }),
    chat('Here are our x and y axes.'),
    DrawLine(100, 500, 900, 500),
    DrawLine(150, 550, 150, 100),
    writeText('x', 880, 490),
    writeText('y', 160, 110),
    chat('Now a line through two points, P1 and P2.'),
    DrawLine(200, 450, 650, 180),
    writeText('P1', 205, 440),
    writeText('P2', 655, 175),
    chat('The rise, the vertical change between the points.'),
    DrawLine(650, 450, 650, 180, { color: '#16a34a' }),
    writeText('rise', 660, 320, { color: '#16a34a' }),
    chat('And the run, the horizontal change.'),
    DrawLine(200, 450, 650, 450, { color: '#dc2626' }),
    writeText('run', 400, 475, { color: '#dc2626' }),
    chat('Slope m is rise over run: m = (y2 - y1) / (x2 - x1)'),
    writeText('m = rise / run', 350, 550, { fontSize: 22, color: '#2563eb' }),
  ];
}

function circleAreaLesson(): LessonStep[] {
  const cx = 500;
  const cy = 300;
  const r = 150;

  return [
    chat("Let's find the area of a circle."),
    writeText('Area of a Circle', 340, 60, { fontSize: 26 }),
    chat("First, I'll draw the circle."),
    drawEllipse(cx, cy, r, r, { color: '#0f172a' }),
    chat('Now the radius, from the center to the edge.'),
    DrawLine(cx, cy, cx + r, cy, { color: '#dc2626' }),
    writeText('r', cx + r / 2, cy - 15, { color: '#dc2626' }),
    chat('The area is pi times the radius squared: A = πr²'),
    writeText('A = πr²', cx - 60, cy + r + 60, { fontSize: 22, color: '#2563eb' }),
  ];
}

const LESSONS: { keywords: string[]; build: () => LessonStep[] }[] = [
  { keywords: ['pythagorean', 'pythagoras', 'right triangle'], build: pythagoreanLesson },
  { keywords: ['slope'], build: slopeLesson },
  { keywords: ['circle', 'area of a circle'], build: circleAreaLesson },
];

export function generateLesson(userInput: string): LessonStep[] {
  const normalized = userInput.toLowerCase();
  const match = LESSONS.find((lesson) =>
    lesson.keywords.some((keyword) => normalized.includes(keyword)),
  );

  if (match) {
    return match.build();
  }

  return [
    chat(
      `I don't have a lesson on that yet. Try asking me about ${FALLBACK_TOPICS.join(', ')}.`,
    ),
  ];
}
