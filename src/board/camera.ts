import { useLayoutEffect, useRef, useState } from 'react';
import { CAMERA_PAN_MS, interpolateCamera, type CameraBox } from './regionLayout';

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * Smoothly pans the camera box. Reduced motion, an explicit instant flag,
 * and the first committed target all jump — compact focus crops must match
 * the derived viewport on the same render as the scene (no stale viewBox).
 */
export function useAnimatedCamera(target: CameraBox, instant: boolean): CameraBox {
  const skipAnim = instant || prefersReducedMotion();
  const fromRef = useRef(target);
  const startRef = useRef<number | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const [current, setCurrent] = useState(target);

  useLayoutEffect(() => {
    const nextTarget = targetRef.current;
    if (skipAnim) {
      fromRef.current = nextTarget;
      setCurrent(nextTarget);
      return;
    }
    if (boxesClose(fromRef.current, nextTarget)) {
      setCurrent(nextTarget);
      return;
    }
    const origin = fromRef.current;
    startRef.current = null;
    let frame = 0;
    const step = (now: number) => {
      if (startRef.current === null) startRef.current = now;
      const t = (now - startRef.current) / CAMERA_PAN_MS;
      const next = interpolateCamera(origin, nextTarget, t);
      fromRef.current = next;
      setCurrent(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target.x, target.y, target.w, target.h, skipAnim]);

  if (skipAnim) return target;
  return current;
}

function boxesClose(a: CameraBox, b: CameraBox): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}
