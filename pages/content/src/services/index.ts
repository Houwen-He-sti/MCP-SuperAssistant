/**
 * Services Index
 * 
 * Centralized export point for all application services
 */

import { createLogger } from '@extension/shared/lib/logger';
const logger = createLogger('Services Index');

export { 
  AutomationService, 
  automationService, 
  initializeAutomationService, 
  cleanupAutomationService,
  type AutomationState,
  type ToolExecutionCompleteDetail
} from './automation.service';

export { ToolResultRenderer } from './tool-result-renderer';
export { ToolLoopCardRenderer } from './tool-loop-card-renderer';

// Export initialization function for all services
export async function initializeAllServices(): Promise<void> {
  logger.debug('[Services] Initializing all application services...');
  
  try {
    // Initialize automation service
    const { initializeAutomationService } = await import('./automation.service');
    initializeAutomationService();

    // Initialize tool result renderer (independent from automation service)
    const { ToolResultRenderer } = await import('./tool-result-renderer');
    await ToolResultRenderer.getInstance().initialize();

    // Initialize tool-loop card renderer (Gate 6C — semantic cards)
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

    // Cleanup tool result renderer
    const { ToolResultRenderer } = await import('./tool-result-renderer');
    ToolResultRenderer.getInstance().cleanup();

    // Cleanup tool-loop card renderer (Gate 6C)
    const { ToolLoopCardRenderer } = await import('./tool-loop-card-renderer');
    ToolLoopCardRenderer.getInstance().stop();
    
    logger.debug('[Services] All services cleaned up successfully');
  } catch (error) {
    logger.error('[Services] Error cleaning up services:', error);
  }
}
