import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Kanban drawer progressive-disclosure theme contract', () => {
  const css = readFileSync(new URL('../dashboard/src/kanban-workflow.css', import.meta.url), 'utf8');
  const bridge = readFileSync(new URL('../dashboard/src/kanban-workflow-bridge.ts', import.meta.url), 'utf8');

  it('uses paired semantic foreground/background tokens for light and dark themes', () => {
    expect(css).toContain('--color-card-foreground');
    expect(css).toContain('--color-card');
    expect(css).toContain('--color-popover-foreground');
    expect(css).toContain('--color-popover');
    expect(css).toContain('--color-primary-foreground');
    expect(css).toContain('--color-primary');
    expect(css).toContain('--color-secondary-foreground');
    expect(css).toContain('--color-secondary');
    expect(css).toContain('--color-accent-foreground');
    expect(css).toContain('--color-accent');
  });

  it('keeps direct conversation and assignment buttons with visible keyboard focus', () => {
    expect(css).toMatch(/hti-kanban-conversation-action[\s\S]*color:[^;]+!important/);
    expect(css).toMatch(/hti-kanban-assign-action[\s\S]*color:[^;]+!important/);
    expect(css).toMatch(/hti-kanban-action:focus-visible[\s\S]*outline:/);
    expect(bridge).toContain("conversationButton.textContent = '对话'");
    expect(bridge).toContain("assignButton.textContent = '指派'");
    expect(bridge).not.toContain('modeSelect');
    expect(bridge).not.toContain('执行方式');
    expect(bridge).toContain('drawerBody?.insertBefore(control, drawerBody.firstChild)');
    expect(bridge).not.toContain('actions.parentElement?.insertBefore(control, actions)');
    expect(bridge).not.toContain('hti-kanban-conversation-button');
  });

  it('adapts execution controls at tablet and phone widths', () => {
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('@media (max-width: 430px)');
    expect(css).toMatch(/max-width: 720px[\s\S]*hti-kanban-action[^}]*width: 100%/);
  });

  it('renders request, understanding, reply and attachments as one divided card', () => {
    expect(css).toContain('.hti-kanban-user-request::before { content: none; }');
    expect(css).toMatch(/hti-kanban-user-request,[\s\S]*hti-kanban-attachments[\s\S]*border-bottom:/);
    expect(css).toMatch(/hti-kanban-user-request[\s\S]*border-radius: \.58rem \.58rem 0 0/);
    expect(css).toMatch(/hti-kanban-attachments \{ border-radius: 0 0 \.58rem \.58rem/);
    expect(css).toMatch(/hti-kanban-understood[\s\S]*hermes-kanban-section-head[\s\S]*display: none !important/);
  });

  it('removes the workflow recommendation and keeps secondary content collapsed', () => {
    expect(bridge).not.toContain('推荐流程：');
    expect(css).toContain('.hti-kanban-workflow-hint { display: none !important; }');
    expect(css).toMatch(/drawer:not\(\.hti-kanban-secondary-open\)[\s\S]*hti-kanban-secondary/);
  });
});
