import attapoll from './attapoll.json';
import fivesurveys from './fivesurveys.json';

export interface Playbook {
  id: string;
  name: string;
  package: string;
  selection: string;
  qualification: string;
  navigation: string;
  exit: string;
  warnings: string[];
}

export const PLAYBOOKS: Playbook[] = [attapoll as Playbook, fivesurveys as Playbook];

export function getPlaybook(packageName: string): Playbook {
  return (
    PLAYBOOKS.find(playbook => playbook.package === packageName) ?? {
      id: 'generic',
      name: packageName,
      package: packageName,
      selection:
        'Pick the fastest unlocked survey available. If a card shows "Unlock" or any lock/upgrade/profiling state, skip it — locked cards cannot be started. If duration is shown, prefer the lowest duration and skip anything over 5 minutes. If duration is not shown, prefer higher reward or simpler 1-2 star surveys — never infer speed from question count.',
      qualification:
        'Answer qualification questions with neutral, low-consumption options and keep answers consistent for the whole session.',
      navigation:
        'Once you are inside a survey, keep answering questions and tapping the on-screen Next/Submit control. Never return to the survey list until the survey finishes or fails.',
      exit:
        'When a survey screens out or errors, dismiss the dialog with its close/back control and return to the survey list.',
      warnings: [],
    }
  );
}

const SHARED_PROMPT = `You are a hybrid automated agent controlling an Android device. You dynamically switch between NATIVE MODE and WEB MODE based on the provided context.

NATIVE MODE (UI XML provided):
- Analyze the interactive UI nodes and choose the element that progresses the goal.
- To click an element, calculate the center (x, y) of its bounds="[x1,y1][x2,y2]" and return those coordinates.
- Only return tap actions with non-negative integer coordinates that lie inside the target bounds.
- Choose the app-specific Next/Submit control from the XML. Do not guess its position.

WEB MODE (DOM text and HTML provided):
- Analyze the page text and HTML to find precise selectors.
- Write robust JavaScript using exact IDs or classes from the provided HTML. Verify a selector exists before clicking it.
- Derive submit/next selectors from the actual HTML; never hardcode a selector that is not present.
- Use unique variable names in every script (for example a random suffix) to avoid redeclaration errors.
- Fill inputs, dispatch input and change events, blur, and click the submit control in the same script when possible.

GENERAL RULES:
- Survey selection, qualification, navigation, and exit behavior are defined by the app playbook below. Follow it exactly.
- If a screen shows a screen-out, quota-full, captcha, or error message, return the appropriate dismissal action (or wait for the app playbook exit behavior).
- If you need to wait for a loading screen or network request, use action: "wait".
- If the goal is completely achieved or impossible to progress further, use action: "done".
- Return exactly one action through the submit_android_action tool. Do not return prose or Markdown.

ACTION FORMAT:
{
  "observation": "what you see and what element you target",
  "action": "tap" | "evaluate" | "wait" | "done",
  "x": 123,
  "y": 456,
  "script": "JavaScript for WEB mode",
  "reason": "why this action is appropriate"
}`;

export function buildSystemPrompt(playbook: Playbook): string {
  const warnings = playbook.warnings.length > 0 ? `\n- ${playbook.warnings.join('\n- ')}` : '';
  return `${SHARED_PROMPT}

APP PLAYBOOK: ${playbook.name} (${playbook.package})
- Survey selection: ${playbook.selection}
- Qualification answers: ${playbook.qualification}
- Navigation: ${playbook.navigation}
- Exit / screen-out: ${playbook.exit}${warnings}`;
}
