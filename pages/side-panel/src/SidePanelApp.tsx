import { useAppStore, useConfigStore, useConnectionStore, useUIStore } from '@src/stores';
import { useEffect, useState } from 'react';

export const SidePanelApp = () => {
    const [activeTab, setActiveTab] = useState<'tools' | 'prompt' | 'settings'>('tools');
    const { status } = useConnectionStore();
    const [isHydrated, setIsHydrated] = useState(false);

    useEffect(() => {
        // Wait for Zustand stores to hydrate from chrome.storage.
        // Only stores with persist middleware support .persist.hasHydrated().
        // connection.store and tool.store have NO persist middleware — do not check them.
        const checkHydration = () => {
            if (useUIStore.persist.hasHydrated() &&
                useAppStore.persist.hasHydrated() &&
                useConfigStore.persist.hasHydrated()) {
                setIsHydrated(true);
            } else {
                setTimeout(checkHydration, 50);
            }
        };
        checkHydration();
    }, []);

    if (!isHydrated) {
        return (
            <div className="flex items-center justify-center h-screen bg-white dark:bg-slate-900">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-screen bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-sans">
            {/* Header */}
            <header className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
                <h1 className="font-semibold text-lg tracking-tight">MCP SuperAssistant</h1>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 dark:text-slate-400 capitalize">{status}</span>
                    <div className={`w-2.5 h-2.5 rounded-full ${status === 'connected' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' :
                            status === 'error' ? 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]' :
                                'bg-slate-400'
                        }`} />
                </div>
            </header>

            {/* Tabs */}
            <nav className="flex border-b border-slate-200 dark:border-slate-800 shrink-0">
                {(['tools', 'prompt', 'settings'] as const).map((tab) => (
                    <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === tab
                                ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                            }`}
                    >
                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                    </button>
                ))}
            </nav>

            {/* Content Area */}
            <main className="flex-1 overflow-y-auto p-4">
                {activeTab === 'tools' && <div className="text-sm text-slate-500">Tools Panel (WIP)</div>}
                {activeTab === 'prompt' && <div className="text-sm text-slate-500">Prompt Panel (WIP)</div>}
                {activeTab === 'settings' && <div className="text-sm text-slate-500">Settings Panel (WIP)</div>}
            </main>
        </div>
    );
};
