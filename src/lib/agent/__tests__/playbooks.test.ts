import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, getPlaybook, PLAYBOOKS } from '@/lib/agent/playbooks';

describe('playbooks', () => {
  it('ships a playbook for each supported survey app', () => {
    expect(PLAYBOOKS.map(playbook => playbook.package).sort()).toEqual([
      'com.fivesurveys.mobile',
      'com.requapp.requ',
    ]);
  });

  it('returns the matching playbook by package name', () => {
    const playbook = getPlaybook('com.requapp.requ');
    expect(playbook.id).toBe('attapoll');
    expect(playbook.navigation.length).toBeGreaterThan(0);
  });

  it('falls back to a generic playbook that still names the package', () => {
    const playbook = getPlaybook('com.example.surveys');
    expect(playbook.id).toBe('generic');
    expect(playbook.package).toBe('com.example.surveys');
    expect(playbook.name).toBe('com.example.surveys');
  });

  it('builds a system prompt with shared rules and app-specific guidance', () => {
    const prompt = buildSystemPrompt(getPlaybook('com.fivesurveys.mobile'));

    expect(prompt).toContain('NATIVE MODE');
    expect(prompt).toContain('WEB MODE');
    expect(prompt).toContain('com.fivesurveys.mobile');
    expect(prompt).toContain('Survey selection:');
    expect(prompt).toContain('Exit / screen-out:');
  });

  it('appends warnings when a playbook declares them', () => {
    const playbook = { ...getPlaybook('com.attapoll.app'), warnings: ['Never reload during a survey.'] };
    expect(buildSystemPrompt(playbook)).toContain('Never reload during a survey.');
  });

  it('instructs the AttaPoll agent to never tap locked survey cards', () => {
    const playbook = getPlaybook('com.requapp.requ');
    expect(playbook.selection).toContain('Unlock surveys');
    expect(playbook.selection).toContain('NEVER tap a card');
    expect(buildSystemPrompt(playbook)).toContain('Unlock surveys');
  });

  it('keeps selection grounded in explicit card facts', () => {
    const playbook = getPlaybook('com.requapp.requ');
    expect(playbook.selection).not.toContain('fewest questions');
    expect(playbook.selection).toContain('Never guess speed from question count');
  });
});
