import { isNotionSubmitButtonReady } from './submit-readiness.ts';

export function createNotionSubmitContext(
    getButton: () => HTMLElement | null,
    deps = {
        getComputedStyle: typeof window !== 'undefined' ? window.getComputedStyle.bind(window) : () => ({ pointerEvents: 'auto' }) as any,
        sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    }
) {
    return {
        getSubmitButton: getButton,
        isSubmitButtonReady: (btn: any) => {
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return false;
            if (btn.disabled === true) return false;
            // Catch native pointerEvents disabling without throwing if style isn't fully mocked
            try {
                if (deps.getComputedStyle(btn).pointerEvents === 'none') {
                    return false;
                }
            } catch (e) {
                // Ignore in case of partial environment
            }
            return isNotionSubmitButtonReady(btn);
        },
        clickSubmitButton: (btn: any) => {
            btn.click();
        },
        sleep: deps.sleep,
    };
}

