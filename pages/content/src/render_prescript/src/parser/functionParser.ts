import type { FunctionInfo } from '../core/types';
import { functionInfoFromValidation, validateFunctionCallElement } from './functionCallValidator';

/**
 * Analyzes content to determine if it contains function calls
 * and related information about their completeness
 *
 * @param block The HTML element containing potential function call content
 * @returns Information about the detected function calls
 */
export const containsFunctionCalls = (block: HTMLElement): FunctionInfo => {
  return functionInfoFromValidation(validateFunctionCallElement(block));
};
