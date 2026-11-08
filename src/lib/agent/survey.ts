export const MAX_SURVEY_STEPS = 120;
export const MAX_NATIVE_SURVEY_MS = 300_000;
export const MAX_WEB_SURVEY_MS = 30_000;

export type SurveyMode = 'NATIVE' | 'WEB';

export interface SurveyState {
  startedAt: number;
  stepCount: number;
  screensVisited: number;
  lastFingerprint: string | null;
  mode: SurveyMode | null;
  modeStartedAt: number | null;
}

export interface SurveyBudgetCheck {
  exceeded: boolean;
  reason: string | null;
}

export function createSurveyState(now = Date.now()): SurveyState {
  return {
    startedAt: now,
    stepCount: 0,
    screensVisited: 0,
    lastFingerprint: null,
    mode: null,
    modeStartedAt: null,
  };
}

export function recordSurveyStep(
  state: SurveyState,
  step: { mode: SurveyMode; fingerprint?: string },
  now = Date.now(),
): SurveyState {
  const next: SurveyState = { ...state, stepCount: state.stepCount + 1 };

  if (next.mode !== step.mode) {
    next.mode = step.mode;
    next.modeStartedAt = now;
  }

  if (step.fingerprint) {
    if (state.lastFingerprint !== step.fingerprint) {
      next.screensVisited = state.screensVisited + 1;
      next.lastFingerprint = step.fingerprint;
    }
  }

  return next;
}

export function checkSurveyBudget(
  state: SurveyState,
  now = Date.now(),
  limits: { maxSteps?: number; maxNativeMs?: number; maxWebMs?: number } = {},
): SurveyBudgetCheck {
  const maxSteps = limits.maxSteps ?? MAX_SURVEY_STEPS;
  const maxNativeMs = limits.maxNativeMs ?? MAX_NATIVE_SURVEY_MS;
  const maxWebMs = limits.maxWebMs ?? MAX_WEB_SURVEY_MS;

  if (state.stepCount >= maxSteps) {
    return { exceeded: true, reason: `Step budget reached (${state.stepCount}/${maxSteps}).` };
  }

  if (state.mode === 'NATIVE' && now - state.startedAt >= maxNativeMs) {
    return { exceeded: true, reason: `Survey ran longer than ${Math.round(maxNativeMs / 1000)}s in NATIVE mode.` };
  }

  if (state.mode === 'WEB' && state.modeStartedAt !== null && now - state.modeStartedAt >= maxWebMs) {
    return { exceeded: true, reason: `Survey stayed in WEB mode longer than ${Math.round(maxWebMs / 1000)}s.` };
  }

  return { exceeded: false, reason: null };
}
