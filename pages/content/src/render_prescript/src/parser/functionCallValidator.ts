import { CONFIG } from '../core/config';
import type { FunctionInfo, ParsedFunctionCall } from '../core/types';

export interface FunctionCallValidationOptions {
  requireStandaloneCodeBlock?: boolean;
  requireRegisteredTool?: boolean;
  toolNames?: Iterable<string>;
}

export interface FunctionCallValidationResult {
  isValid: boolean;
  isComplete: boolean;
  isExecutable: boolean;
  reason?: string;
  call?: ParsedFunctionCall;
}

interface MinimalElement {
  tagName?: string;
  parentElement?: MinimalElement | null;
  textContent?: string | null;
  closest?: (selector: string) => Element | null;
}

interface ParsedJSONLine {
  type?: string;
  name?: string;
  call_id?: string | number;
  text?: string;
  key?: string;
  value?: any;
}

const EMPTY_FUNCTION_INFO: FunctionInfo = {
  hasFunctionCalls: false,
  isComplete: false,
  hasInvoke: false,
  hasParameters: false,
  hasClosingTags: false,
  languageTag: null,
  detectedBlockType: null,
  partialTagDetected: false,
};

const KNOWN_CODE_LANGUAGES =
  'javascript|typescript|markdown|csharp|kotlin|python|jsonl|bash|rust|java|scala|swift|shell|json|text|perl|yaml|toml|html|ruby|cpp|php|lua|css|sql|yml|ini|xml|ts|js|py|sh|md|cs|go|rb|c|r';

const countMatches = (content: string, regex: RegExp): number => {
  const matches = content.match(regex);
  return matches ? matches.length : 0;
};

const getAttributeValue = (attributes: string, name: string): string | null => {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`, 'i'));
  return match?.[1] || null;
};

const createInvalidResult = (reason: string): FunctionCallValidationResult => ({
  isValid: false,
  isComplete: false,
  isExecutable: false,
  reason,
});

const createCallResult = (call: Omit<ParsedFunctionCall, 'isExecutable'>): FunctionCallValidationResult => {
  const parsedCall: ParsedFunctionCall = {
    ...call,
    isExecutable: call.isComplete,
  };

  return {
    isValid: true,
    isComplete: parsedCall.isComplete,
    isExecutable: parsedCall.isExecutable,
    call: parsedCall,
  };
};

const stripCodeBlockAffordances = (content: string): string => {
  let cleaned = content.trim();

  const fenced = cleaned.match(new RegExp(`^\`\`\`(?:${KNOWN_CODE_LANGUAGES})?\\s*\\r?\\n([\\s\\S]*?)\\r?\\n?\`\`\`$`, 'i'));
  if (fenced) {
    cleaned = fenced[1].trim();
  }

  cleaned = cleaned.replace(new RegExp(`^(?:${KNOWN_CODE_LANGUAGES})(?:\\s+copy(?:\\s+code)?|\\s*复制代码)?\\s*\\r?\\n`, 'i'), '');
  cleaned = cleaned.replace(/^[cC]opy(?:\s+code)?\s*\r?\n/i, '');

  return cleaned.trim();
};

const getToolNameSet = (options: FunctionCallValidationOptions): Set<string> => {
  if (options.toolNames !== undefined) {
    return new Set(Array.from(options.toolNames).filter((name): name is string => typeof name === 'string' && name.length > 0));
  }

  return getRegisteredToolNames();
};

const validateToolName = (
  functionName: string | null,
  options: FunctionCallValidationOptions,
): { valid: boolean; reason?: string } => {
  if (!functionName) {
    return { valid: false, reason: 'missing function name' };
  }

  if (options.requireRegisteredTool === false) {
    return { valid: true };
  }

  const toolNames = getToolNameSet(options);
  if (toolNames.size === 0) {
    return { valid: false, reason: 'tool registry unavailable' };
  }

  if (!toolNames.has(functionName)) {
    return { valid: false, reason: `unknown tool: ${functionName}` };
  }

  return { valid: true };
};

const extractXMLParameters = (content: string): Record<string, any> => {
  const parameters: Record<string, any> = {};
  const parameterRegex = /<parameter\b([^>]*)>([\s\S]*?)<\/parameter>/gi;

  let match: RegExpExecArray | null;
  while ((match = parameterRegex.exec(content)) !== null) {
    const name = getAttributeValue(match[1], 'name');
    if (!name) continue;

    let value: any = match[2].trim();
    const cdataMatch = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdataMatch) {
      value = cdataMatch[1].trim();
    }

    parameters[name] = value;
  }

  return parameters;
};

const extractJSONObjects = (content: string): string[] => {
  const objects: string[] = [];
  let i = 0;

  while (i < content.length) {
    if (content[i] !== '{') {
      i++;
      continue;
    }

    const startIndex = i;
    let depth = 1;
    let inString = false;
    let escapeNext = false;
    i++;

    while (i < content.length && depth > 0) {
      const char = content[i];

      if (escapeNext) {
        escapeNext = false;
      } else if (char === '\\' && inString) {
        escapeNext = true;
      } else if (char === '"') {
        inString = !inString;
      } else if (!inString) {
        if (char === '{') depth++;
        if (char === '}') depth--;
      }

      i++;
    }

    if (depth === 0) {
      objects.push(content.substring(startIndex, i));
    }
  }

  return objects;
};

const parseJSONFunctionLines = (content: string): ParsedJSONLine[] => {
  return extractJSONObjects(content)
    .map(json => {
      try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? (parsed as ParsedJSONLine) : null;
      } catch {
        return null;
      }
    })
    .filter((line): line is ParsedJSONLine => !!line && typeof line.type === 'string');
};

const parseXMLFunctionCall = (
  content: string,
  options: FunctionCallValidationOptions,
): FunctionCallValidationResult => {
  const source = stripCodeBlockAffordances(content);

  if (!source.includes('<function_calls>') && !source.includes('<invoke')) {
    return createInvalidResult('no XML function-call markers');
  }

  const completeRootMatch = source.match(/^<function_calls>\s*([\s\S]*?)\s*<\/function_calls>$/);

  if (!completeRootMatch) {
    if (!source.startsWith('<function_calls>')) {
      return createInvalidResult('XML root is not function_calls');
    }

    const streamingInvokeMatch = source.match(/<invoke\b([^>]*)>/i);
    const functionName = streamingInvokeMatch ? getAttributeValue(streamingInvokeMatch[1], 'name') : null;
    const toolCheck = validateToolName(functionName, options);
    if (!toolCheck.valid) {
      return createInvalidResult(toolCheck.reason || 'invalid streaming XML tool name');
    }

    return createCallResult({
      format: 'xml',
      functionName: functionName!,
      callId: getAttributeValue(streamingInvokeMatch![1], 'call_id') || `call-${Date.now()}`,
      parameters: extractXMLParameters(source),
      isComplete: false,
      rawContent: source,
    });
  }

  if (countMatches(source, /<function_calls>/g) !== 1 || countMatches(source, /<\/function_calls>/g) !== 1) {
    return createInvalidResult('XML root tags are not canonical');
  }

  const inner = completeRootMatch[1];
  const invokeOpenCount = countMatches(inner, /<invoke\b/gi);
  const invokeCloseCount = countMatches(inner, /<\/invoke>/gi);

  if (invokeOpenCount === 0) {
    return createInvalidResult('missing invoke');
  }

  if (invokeOpenCount !== invokeCloseCount) {
    return createInvalidResult('unbalanced invoke tags');
  }

  const parameterOpenCount = countMatches(inner, /<parameter\b/gi);
  const parameterCloseCount = countMatches(inner, /<\/parameter>/gi);
  if (parameterOpenCount !== parameterCloseCount) {
    return createInvalidResult('unbalanced parameter tags');
  }

  const invokeMatches = Array.from(inner.matchAll(/<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi));
  if (invokeMatches.length !== invokeOpenCount) {
    return createInvalidResult('incomplete invoke structure');
  }

  const invokeNames = invokeMatches.map(match => getAttributeValue(match[1], 'name'));
  if (invokeNames.some(name => !name)) {
    return createInvalidResult('invoke missing name');
  }

  for (const name of invokeNames) {
    const toolCheck = validateToolName(name, options);
    if (!toolCheck.valid) {
      return createInvalidResult(toolCheck.reason || 'invalid XML tool name');
    }
  }

  const firstInvoke = invokeMatches[0];
  const firstInvokeAttributes = firstInvoke[1];
  const functionName = getAttributeValue(firstInvokeAttributes, 'name')!;
  const callId = getAttributeValue(firstInvokeAttributes, 'call_id') || `call-${Date.now()}`;

  return createCallResult({
    format: 'xml',
    functionName,
    callId,
    parameters: extractXMLParameters(firstInvoke[2]),
    isComplete: true,
    rawContent: source,
  });
};

const parseJSONFunctionCall = (
  content: string,
  options: FunctionCallValidationOptions,
): FunctionCallValidationResult => {
  const source = stripCodeBlockAffordances(content);

  if (!source.includes('"type"') || !source.includes('function_call')) {
    return createInvalidResult('no JSONL function-call markers');
  }

  const lines = parseJSONFunctionLines(source);
  const start = lines.find(line => line.type === 'function_call_start');

  if (!start) {
    return createInvalidResult('missing function_call_start');
  }

  const functionName = typeof start.name === 'string' && start.name.length > 0 ? start.name : null;
  const toolCheck = validateToolName(functionName, options);
  if (!toolCheck.valid) {
    return createInvalidResult(toolCheck.reason || 'invalid JSONL tool name');
  }

  const hasEnd = lines.some(line => line.type === 'function_call_end');
  const parameters: Record<string, any> = {};
  for (const line of lines) {
    if (line.type === 'parameter' && typeof line.key === 'string') {
      parameters[line.key] = line.value ?? '';
    }
  }

  return createCallResult({
    format: 'json',
    functionName: functionName!,
    callId: start.call_id?.toString() || `call-${Date.now()}`,
    parameters,
    isComplete: hasEnd,
    rawContent: source,
  });
};

export const isStandaloneCodeBlock = (element: MinimalElement | null | undefined): boolean => {
  const tag = element?.tagName?.toLowerCase();
  if (tag === 'pre') return true;
  if (tag === 'code' && element?.parentElement?.tagName?.toLowerCase() === 'pre') return true;
  // Also accept elements matching configured targetSelectors (for sites like Notion using div-based code blocks)
  if (element && typeof (element as any).matches === 'function') {
    for (const selector of CONFIG.targetSelectors) {
      if (selector !== 'pre' && selector !== 'code') {
        try {
          if ((element as any).matches(selector)) return true;
        } catch { /* invalid selector */ }
      }
    }
  }
  return false;
};

export const getStandaloneCodeBlockElement = (element: HTMLElement): HTMLElement | null => {
  if (isStandaloneCodeBlock(element)) {
    return element.tagName.toLowerCase() === 'code' ? (element.parentElement as HTMLElement) : element;
  }

  const nearestPre = element.closest?.('pre');
  if (nearestPre instanceof HTMLElement) return nearestPre;

  // For sites using non-pre code blocks (e.g., Notion uses div.notion-code-block),
  // check if any ancestor matches the configured targetSelectors
  for (const selector of CONFIG.targetSelectors) {
    if (selector !== 'pre' && selector !== 'code') {
      try {
        const match = element.closest?.(selector);
        if (match instanceof HTMLElement) return match;
      } catch { /* invalid selector */ }
    }
  }

  return null;
};

export const getRegisteredToolNames = (): Set<string> => {
  const names = new Set<string>();

  if (typeof window === 'undefined') {
    return names;
  }

  const addToolName = (name: unknown): void => {
    if (typeof name === 'string' && name.length > 0) {
      names.add(name);
    }
  };

  const addTools = (tools: unknown): void => {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      if (typeof tool === 'string') {
        addToolName(tool);
      } else if (tool && typeof tool === 'object') {
        addToolName((tool as { name?: unknown }).name);
      }
    }
  };

  const win = window as any;
  addTools(win.__mcpToolNames);
  addTools(win.__mcpAvailableTools);
  addTools(win.availableTools);

  return names;
};

export const validateFunctionCallContent = (
  content: string,
  options: FunctionCallValidationOptions = {},
): FunctionCallValidationResult => {
  const normalizedOptions = {
    requireStandaloneCodeBlock: options.requireStandaloneCodeBlock ?? false,
    requireRegisteredTool: options.requireRegisteredTool ?? true,
    toolNames: options.toolNames,
  };

  const xmlResult = parseXMLFunctionCall(content, normalizedOptions);
  if (xmlResult.isValid) return xmlResult;

  const jsonResult = parseJSONFunctionCall(content, normalizedOptions);
  if (jsonResult.isValid) return jsonResult;

  return createInvalidResult(`${xmlResult.reason}; ${jsonResult.reason}`);
};

export const validateFunctionCallElement = (
  element: HTMLElement,
  options: FunctionCallValidationOptions = {},
): FunctionCallValidationResult => {
  const requireStandaloneCodeBlock = options.requireStandaloneCodeBlock ?? true;
  if (requireStandaloneCodeBlock && !isStandaloneCodeBlock(element)) {
    return createInvalidResult('not a standalone code block');
  }

  return validateFunctionCallContent(element.textContent?.trim() || '', {
    ...options,
    requireStandaloneCodeBlock: false,
  });
};

export const functionInfoFromValidation = (validation: FunctionCallValidationResult): FunctionInfo => {
  if (!validation.isValid || !validation.call) {
    return {
      ...EMPTY_FUNCTION_INFO,
      validationReason: validation.reason,
    };
  }

  const { call } = validation;
  return {
    hasFunctionCalls: true,
    isComplete: validation.isComplete,
    hasInvoke: true,
    hasParameters: Object.keys(call.parameters).length > 0,
    hasClosingTags: validation.isComplete,
    languageTag: null,
    detectedBlockType: call.format === 'xml' ? 'antml' : 'json',
    partialTagDetected: !validation.isComplete,
    invokeName: call.functionName,
    callId: call.callId,
    parameters: call.parameters,
    isExecutable: validation.isExecutable,
    validatedCall: call,
  };
};

export const hasFunctionCallLikePattern = (content: string): boolean => {
  return (
    content.includes('<function_calls>') ||
    content.includes('<invoke') ||
    (content.includes('"type"') && (content.includes('function_call') || content.includes('parameter')))
  );
};

export const isExecutableFunctionCall = (call: ParsedFunctionCall | undefined): boolean => {
  return !!call && call.isComplete && call.isExecutable;
};
