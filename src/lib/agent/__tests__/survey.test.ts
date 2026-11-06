import { describe, expect, it } from 'vitest';
import {
  checkSurveyBudget,
  createSurveyState,
  MAX_NATIVE_SURVEY_MS,
  MAX_SURVEY_STEPS,
  MAX_WEB_SURVEY_MS,
  recordSurveyStep,
} from '@/lib/agent/survey';

describe('survey state machine', () => {
  it('starts a fresh state with the survey start time', () => {
    expect(createSurveyState(1000)).toEqual({
      startedAt: 1000,
      stepCount: 0,
      screensVisited: 0,
      lastFingerprint: null,
      mode: null,
      modeStartedAt: null,
    });
  });

  it('counts steps and unique screens', () => {
    let state = createSurveyState(0);
    state = recordSurveyStep(state, { mode: 'NATIVE', fingerprint: 'screen-a' }, 1000);
    state = recordSurveyStep(state, { mode: 'NATIVE', fingerprint: 'screen-a' }, 2000);
    state = recordSurveyStep(state, { mode: 'NATIVE', fingerprint: 'screen-b' }, 3000);
    expect(state.stepCount).toBe(3);
    expect(state.screensVisited).toBe(2);
    expect(state.modeStartedAt).toBe(1000);
  });

  it('restarts the mode clock when the mode changes', () => {
    let state = createSurveyState(0);
    state = recordSurveyStep(state, { mode: 'NATIVE' }, 1000);
    state = recordSurveyStep(state, { mode: 'NATIVE' }, 2000);
    state = recordSurveyStep(state, { mode: 'WEB' }, 5000);
    expect(state.mode).toBe('WEB');
    expect(state.modeStartedAt).toBe(5000);
  });

  it('enforces the step budget', () => {
    let state = createSurveyState(0);
    for (let i = 0; i < MAX_SURVEY_STEPS; i++) {
      state = recordSurveyStep(state, { mode: 'NATIVE' }, i);
    }
    expect(checkSurveyBudget(state, MAX_SURVEY_STEPS)).toEqual({
      exceeded: true,
      reason: `Step budget reached (${MAX_SURVEY_STEPS}/${MAX_SURVEY_STEPS}).`,
    });
  });

  it('enforces the web mode timeout', () => {
    let state = createSurveyState(0);
    state = recordSurveyStep(state, { mode: 'WEB' }, 10_000);
    expect(checkSurveyBudget(state, 10_000 + MAX_WEB_SURVEY_MS).exceeded).toBe(true);
    expect(checkSurveyBudget(state, 10_000 + MAX_WEB_SURVEY_MS - 1).exceeded).toBe(false);
  });

  it('enforces the native survey wall-clock timeout', () => {
    let state = createSurveyState(0);
    state = recordSurveyStep(state, { mode: 'NATIVE' }, 5_000);
    expect(checkSurveyBudget(state, MAX_NATIVE_SURVEY_MS + 1).exceeded).toBe(true);
    expect(checkSurveyBudget(state, MAX_NATIVE_SURVEY_MS - 1).exceeded).toBe(false);
  });

  it('stays within budget for a short healthy survey', () => {
    let state = createSurveyState(0);
    state = recordSurveyStep(state, { mode: 'NATIVE', fingerprint: 'a' }, 1000);
    state = recordSurveyStep(state, { mode: 'NATIVE', fingerprint: 'b' }, 2000);
    expect(checkSurveyBudget(state, 5000)).toEqual({ exceeded: false, reason: null });
  });
});
