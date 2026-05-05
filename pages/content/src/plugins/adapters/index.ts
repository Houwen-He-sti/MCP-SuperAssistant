/**
 * Adapter Plugins Export Module
 * 
 * This file exports all available adapter plugins for the MCP-SuperAssistant.
 */

export { AIStudioAdapter } from './aistudio.adapter';
export { BaseAdapterPlugin } from './base.adapter';
export { DeepSeekAdapter } from './deepseek.adapter';
export { DefaultAdapter } from './default.adapter';
export { ExampleForumAdapter } from './example-forum.adapter';
export { GeminiAdapter } from './gemini.adapter';
export { GitHubCopilotAdapter } from './ghcopilot.adapter';
export { GrokAdapter } from './grok.adapter';
export { MistralAdapter } from './mistral.adapter';
export { NotionAdapter } from './notion.adapter';
export { OpenRouterAdapter } from './openrouter.adapter';
export { PerplexityAdapter } from './perplexity.adapter';
export { T3ChatAdapter } from './t3chat.adapter';


// Export types
export type {
  AdapterCapability, AdapterConfig, AdapterPlugin, PluginContext, PluginRegistration
} from '../plugin-types';

