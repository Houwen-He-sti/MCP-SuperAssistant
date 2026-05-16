export interface StoredBridgePreferences {
    autoExecute?: unknown;
    autoInsert?: unknown;
    autoSubmit?: unknown;
}

export interface StoredBridgeState {
    mcpEnabled?: unknown;
    preferences?: StoredBridgePreferences | null;
}

export interface DerivedStoredBridgeConfig {
    enabled: boolean;
    cutoffEnabled: boolean;
    autoInsert?: boolean;
    autoSubmit?: boolean;
}

export function deriveStoredBridgeConfig(state: StoredBridgeState | null | undefined): DerivedStoredBridgeConfig {
    const preferences = state?.preferences || {};
    const executionEnabled = state?.mcpEnabled === true && preferences.autoExecute === true;
    const config: DerivedStoredBridgeConfig = {
        enabled: executionEnabled,
        cutoffEnabled: executionEnabled,
    };

    if (typeof preferences.autoInsert === 'boolean') config.autoInsert = preferences.autoInsert;
    if (typeof preferences.autoSubmit === 'boolean') config.autoSubmit = preferences.autoSubmit;
    return config;
}