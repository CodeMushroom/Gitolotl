import type { Commit } from "./api";

const AGENTS: [RegExp, string][] = [
  [/claude|anthropic/i, "Claude"],
  [/copilot/i, "Copilot"],
  [/cursor/i, "Cursor"],
  [/codex|openai|chatgpt/i, "Codex"],
  [/gemini|jules/i, "Gemini"],
  [/devin/i, "Devin"],
  [/aider/i, "Aider"],
  [/windsurf|codeium/i, "Windsurf"],
  [/amazon q|codewhisperer/i, "Amazon Q"],
  [/\[bot\]/i, "Bot"],
];

/** Name of the AI agent that authored or co-authored a commit, if any. */
export function aiAgent(c: Commit): string | null {
  const who = [...c.coauthors, `${c.author} <${c.email}>`].join(" | ");
  for (const [re, name] of AGENTS) if (re.test(who)) return name;
  return null;
}
