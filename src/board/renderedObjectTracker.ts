export type NavigationCause = 'initial_anchor' | 'notice_open' | 'picker' | 'draft_restore';

export interface AnnouncedBoardNavigation {
  previousGroupId: string | null;
  nextGroupId: string;
  cause: NavigationCause;
}

export interface RenderedTutorObjectSnapshot {
  visibleTutorIds: readonly string[];
  allTutorIds: readonly string[];
  navigation?: AnnouncedBoardNavigation | null;
}

export interface TutorObjectDisappearance {
  objectId: string;
  cause: 'scene_mutation' | 'unknown';
}

export class RenderedTutorObjectTracker {
  private previouslyVisible: Set<string> | null = null;

  observe(snapshot: RenderedTutorObjectSnapshot): TutorObjectDisappearance[] {
    const visible = new Set(snapshot.visibleTutorIds);
    const all = new Set(snapshot.allTutorIds);
    const previous = this.previouslyVisible;
    this.previouslyVisible = visible;
    if (!previous) return [];

    const disappearances: TutorObjectDisappearance[] = [];
    for (const objectId of previous) {
      if (visible.has(objectId)) continue;
      if (!all.has(objectId)) {
        disappearances.push({ objectId, cause: 'scene_mutation' });
      } else if (!snapshot.navigation) {
        disappearances.push({ objectId, cause: 'unknown' });
      }
    }
    return disappearances;
  }

  reset(): void {
    this.previouslyVisible = null;
  }
}
