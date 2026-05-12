import { expect, test } from "vitest";
import { NotionAdapter } from "../notion.adapter";

test("adapter injects fallback node into context dynamically", () => {
    let callCount = 0;
    const mockNodes = [
        { isMock: "detached" } as any,
        { isMock: "connected" } as any
    ];
    
    // Simulate DOM querying by adapter
    const getButton = () => {
        return mockNodes[callCount++] as HTMLElement;
    };
    const adapter = new NotionAdapter();
    const context = adapter.createSubmitContext(getButton);
    
    const firstGet = context.getSubmitButton();
    const secondGet = context.getSubmitButton();
    
    // Proves cache is bypassed/de-coupled in adapter
    expect((firstGet as any).isMock).toBe("detached");
    expect((secondGet as any).isMock).toBe("connected");
});

