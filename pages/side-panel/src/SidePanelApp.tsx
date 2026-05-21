import { useAppStore, useConfigStore, useConnectionStore, useToolStore, useUIStore } from '@src/stores';
import { useEffect, useState } from 'react';

// Custom hook for event-driven hydration with timeout fallback.
// Avoids the polling anti-pattern (infinite setTimeout loop).
// Only stores with persist middleware are checked: ui / app / config.
// connection.store and tool.store have NO persist middleware.
const useHydration = () => {
    const [isHydrated, setIsHydrated] = useState(false);

    useEffect(() => {
        const check = () => {
            if (
                useUIStore.persist.hasHydrated() &&
                useAppStore.persist.hasHydrated() &&
                useConfigStore.persist.hasHydrated()
            ) {
                setIsHydrated(true);
            }
        };

        // Check immediately (already hydrated for sync storage)
        check();

        // 3s hard timeout: prevent infinite loading if storage is unavailable
        const timeoutId = setTimeout(() => {
            console.warn('[SidePanel] Hydration timeout after 3s — forcing render.');
            setIsHydrated(true);
        }, 3000);

        // Event-driven: subscribe to hydration completion (no polling needed)
        const unsubUI = useUIStore.persist.onFinishHydration(check);
        const unsubApp = useAppStore.persist.onFinishHydration(check);
        const unsubConfig = useConfigStore.persist.onFinishHydration(check);

        return () => {
            clearTimeout(timeoutId);
            unsubUI();
            unsubApp();
            unsubConfig();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return isHydrated;
};

const getStatusDotClass = (status: string) => {
    switch (status) {
        case 'connected':
            return 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]';
        case 'error':
        case 'disconnected':
            return 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]';
        case 'connecting':
        case 'reconnecting':
            return 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)] animate-pulse';
        default:
            return 'bg-slate-400';
    }
};

export const SidePanelApp = () => {
    const [activeTab, setActiveTab] = useState<'tools' | 'prompt' | 'settings'>('tools');
    const { status } = useConnectionStore();
    const { tools } = useToolStore();
    const isHydrated = useHydration();

    // [UI-3] Fetch initial snapshot from background and subscribe to runtime broadcasts
    useEffect(() => {
        // Initial connection status fetch
        chrome.runtime.sendMessage(
            { type: 'mcp:get-connection-status', origin: 'side-panel', timestamp: Date.now() },
            (res) => {
                if (chrome.runtime.lastError) return;
                if (res?.success && res.payload) {
                    useConnectionStore.getState().setConnectionStatus({
                        status: res.payload.status ?? 'disconnected',
                        isConnected: res.payload.isConnected ?? false,
                        error: res.payload.error,
                    });
                }
            },
        );

        // Initial tools fetch
        chrome.runtime.sendMessage(
            { type: 'mcp:get-tools', origin: 'side-panel', timestamp: Date.now() },
            (res) => {
                if (chrome.runtime.lastError) return;
                if (res?.success && Array.isArray(res.payload)) {
                    useToolStore.getState().setTools(res.payload);
                }
            },
        );

        // Subscribe to background broadcasts (connection status + tools updates)
        const handleMessage = (msg: { type?: string; payload?: any }) => {
            if (msg.type === 'connection:status-changed' && msg.payload) {
                useConnectionStore.getState().setConnectionStatus({
                    status: msg.payload.status ?? 'disconnected',
                    isConnected: msg.payload.isConnected ?? false,
                    error: msg.payload.error,
                });
            }
            if (msg.type === 'mcp:tool-update' && Array.isArray(msg.payload?.tools)) {
                useToolStore.getState().setTools(msg.payload.tools);
            }
        };

        chrome.runtime.onMessage.addListener(handleMessage);
        return () => {
            chrome.runtime.onMessage.removeListener(handleMessage);
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    if (!isHydrated) {
        return (
            <div className="flex flex-col items-center justify-center h-full min-h-screen bg-white dark:bg-slate-900">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 dark:border-blue-400"></div>
                <span className="mt-4 text-sm text-slate-500 dark:text-slate-400 animate-pulse">Loading workspace...</span>
            </div>
        );
    }

    return (
        // h-full + min-h-screen avoids the overflow quirk of 100vh in Side Panel
        <div className="flex flex-col h-full min-h-screen bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-sans">
            {/* Header — sticky with backdrop blur when content scrolls behind it */}
            <header className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-800 shrink-0 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm sticky top-0 z-10">
                <h1 className="font-semibold text-lg tracking-tight">MCP SuperAssistant</h1>
                <div className="flex items-center gap-2" title={`Status: ${status}`}>
                    <span className="text-xs text-slate-500 dark:text-slate-400 capitalize">{status}</span>
                    <div className={`w-2.5 h-2.5 rounded-full transition-colors duration-300 ${getStatusDotClass(status)}`} />
                </div>
            </header>

            {/* Tabs */}
            <nav className="flex border-b border-slate-200 dark:border-slate-800 shrink-0">
                {(['tools', 'prompt', 'settings'] as const).map((tab) => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`flex-1 py-3 text-sm font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset ${
                            activeTab === tab
                                ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400 bg-blue-50/50 dark:bg-blue-900/10'
                                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800/50'
                        }`}
                    >
                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </button>
                ))}
            </nav>

            {/* Content Area — use hidden/block to preserve scroll position and component state on tab switch */}
            <main className="flex-1 overflow-y-auto relative">
                <div className={`absolute inset-0 p-4 ${activeTab === 'tools' ? 'block' : 'hidden'}`}>
                    {tools.length > 0 ? (
                        <ul className="space-y-1">
                            {tools.map((tool) => (
                                <li key={tool.name} className="text-sm text-slate-700 dark:text-slate-300 py-1 px-2 rounded hover:bg-slate-100 dark:hover:bg-slate-800">
                                    <span className="font-medium">{tool.name}</span>
                                    {tool.description && (
                                        <span className="ml-2 text-xs text-slate-500 dark:text-slate-400 truncate max-w-xs">{tool.description}</span>
                                    )}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <div className="text-sm text-slate-500">No tools available. Connect to an MCP server.</div>
                    )}
                </div>
                <div className={`absolute inset-0 p-4 ${activeTab === 'prompt' ? 'block' : 'hidden'}`}>
                    <div className="text-sm text-slate-500">Prompt Panel (WIP)</div>
                </div>
                <div className={`absolute inset-0 p-4 ${activeTab === 'settings' ? 'block' : 'hidden'}`}>
                    <div className="text-sm text-slate-500">Settings Panel (WIP)</div>
                </div>
            </main>
        </div>
    );
};
