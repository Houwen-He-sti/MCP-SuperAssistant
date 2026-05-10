// pages/content/src/utils/instructionGenerator.ts
import { assembleInstructions } from './promptTemplateLoader';
import { createLogger } from '@extension/shared/lib/logger';

/**
 * Generates instructions for using MCP tools based on available tools.
 * Templates are loaded from external files (prompt-templates/ directory).
 * @param tools Array of available tools with their schemas
 * @param customInstructions Optional custom instructions to include
 * @param customInstructionsEnabled Whether custom instructions should be included
 * @returns Formatted instructions string
 */

const logger = createLogger('InstructionGeneratorJSON');

export const generateInstructionsJson = (
  tools: Array<{ name: string; schema: string; description: string }>,
  customInstructions?: string,
  customInstructionsEnabled?: boolean,
): string => {
  // Detect current platform
  const currentHost = typeof window !== 'undefined' ? window.location.hostname : '';
  let platform = 'default';
  if (currentHost.includes('gemini')) platform = 'gemini';
  if (currentHost.includes('chatgpt')) platform = 'chatgpt';
  if (currentHost.includes('notion')) platform = 'notion';

  return assembleInstructions({
    tools,
    platform,
    customInstructions,
    customInstructionsEnabled,
  });
};
