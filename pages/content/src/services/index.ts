/**
 * Services Index
 * 
 * Centralized export point for all application services
 */

import { createLogger } from '@extension/shared/lib/logger';
const logger = createLogger('Services Index');

export {
  AutomationService,
  automationService, cleanupAutomationService, initializeAutomationService, type AutomationState,
  type ToolExecutionCompleteDetail
} from './automation.service';

export { ToolLoopCardRenderer } from './tool-loop-card-renderer';
export { ToolResultRenderer } from './tool-result-renderer';

// Export initialization function for all services
export async function initializeAllServices(): Promise<void> {
  logger.debug('[Services] Initializing all application services...');

  try {
    // Initialize automation service
    const { initializeAutomationService } = await import('./automation.service');
    initializeAutomationService();

    // Gate 6D: ToolResultRenderer v1 is no longer auto-initialized.
    // ToolLoopCardRenderer v2 is the sole default card renderer.
    // v1 remains exported for manual rollback/compatibility.
    // Do NOT remove mcp:tool-execution-complete dispatch — AutomationService depends on it.

    // Initialize tool-loop card renderer (Gate 6C — semantic cards, now sole renderer)
    const { ToolLoopCardRenderer } = await import('./tool-loop-card-renderer');
    await ToolLoopCardRenderer.getInstance().start();

    logger.debug('[Services] All services initialized successfully');
  } catch (error) {
    logger.error('[Services] Error initializing services:', error);
    throw error;
  }
}

// Export cleanup function for all services
export async function cleanupAllServices(): Promise<void> {
  logger.debug('[Services] Cleaning up all application services...');

  try {
    // Cleanup automation service
    const { cleanupAutomationService } = await import('./automation.service');
    cleanupAutomationService();

    // Gate 6D: v1 ToolResultRenderer no longer auto-initialized, no cleanup needed.
    // Manual legacy renderer users are responsible for their own cleanup.

    // Cleanup tool-loop card renderer (Gate 6C, now sole renderer)
    const { ToolLoopCardRenderer } = await import('./tool-loop-card-renderer');
    ToolLoopCardRenderer.getInstance().stop();

    logger.debug('[Services] All services cleaned up successfully');
  } catch (error) {
    logger.error('[Services] Error cleaning up services:', error);
  }
}
