import { installHarness } from './common.ts';
export const installClaudeCode = (cwd=process.cwd()) => installHarness({name:'claude-code',settings:'.claude/settings.local.json',instructions:'CLAUDE.md'},cwd);
