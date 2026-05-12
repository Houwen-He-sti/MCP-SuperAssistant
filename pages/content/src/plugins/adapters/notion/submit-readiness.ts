export type SubmitClickResult =
    | {
        ok: true;
        attempts: number;
    }
    | {
        ok: false;
        // 'aborted' reserved for future cancellation if needed
        reason: 'button_not_found' | 'button_disabled' | 'click_failed';
        attempts: number;
        error?: unknown;
    };

export interface SubmitContext<TButton> {
    getSubmitButton(): TButton | null;
    isSubmitButtonReady(button: TButton): boolean;
    clickSubmitButton(button: TButton): void | Promise<void>;
    sleep(ms: number): Promise<void>;
}

export type NotionSubmitButtonLike = {
    isConnected?: boolean;
    getAttribute(name: string): string | null;
};

export function isNotionSubmitButtonReady(button: NotionSubmitButtonLike): boolean {
    return button.isConnected !== false && button.getAttribute('aria-disabled') !== 'true';
}

export async function waitForSubmitButtonAndClick<TButton>(
    context: SubmitContext<TButton>,
    options: {
        maxAttempts?: number;
        intervalMs?: number;
    } = {}
): Promise<SubmitClickResult> {
    const maxAttempts = options.maxAttempts ?? 50;
    const intervalMs = options.intervalMs ?? 100;

    let sawButton = false;

    for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
        const button = context.getSubmitButton();

        if (button !== null) {
            sawButton = true;
            if (context.isSubmitButtonReady(button)) {
                try {
                    await context.clickSubmitButton(button);
                    return { ok: true, attempts: attempt };
                } catch (error) {
                    return { ok: false, reason: 'click_failed', attempts: attempt, error };
                }
            }
        }

        if (attempt < maxAttempts) {
            await context.sleep(intervalMs);
        }
    }

    return {
        ok: false,
        reason: sawButton ? 'button_disabled' : 'button_not_found',
        attempts: maxAttempts,
    };
}
