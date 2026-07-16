import { mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const AGENT_RULES_HANDOFF_RELATIVE_PATH = '.vk-agents/runtime/agent-rules.path';

export function defaultAgentRulesPath() {
  return resolve(__dirname, '..', '..', 'docs', 'agent-rules.md');
}

export function writeAgentRulesHandoff({ homeDir = homedir(), rulesPath = defaultAgentRulesPath() } = {}) {
  const resolvedRulesPath = resolve(rulesPath);
  const handoffPath = resolve(homeDir, AGENT_RULES_HANDOFF_RELATIVE_PATH);
  mkdirSync(dirname(handoffPath), { recursive: true });
  writeFileSync(handoffPath, `${resolvedRulesPath}\n`, 'utf8');
  return resolvedRulesPath;
}
