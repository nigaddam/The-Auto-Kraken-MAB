import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseSystemKeepAwake, requestSystemKeepAwake } from "../src/background/power";

describe("power keep-awake helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "chrome");
  });

  it('requests system keep-awake using chrome.power.requestKeepAwake("system")', () => {
    const requestKeepAwake = vi.fn();
    (globalThis as unknown as { chrome: Partial<typeof chrome> }).chrome = {
      power: {
        requestKeepAwake,
        releaseKeepAwake: vi.fn(),
      },
    };

    expect(requestSystemKeepAwake()).toEqual({ ok: true });
    expect(requestKeepAwake).toHaveBeenCalledWith("system");
  });

  it("releases keep-awake through chrome.power.releaseKeepAwake", () => {
    const releaseKeepAwake = vi.fn();
    (globalThis as unknown as { chrome: Partial<typeof chrome> }).chrome = {
      power: {
        requestKeepAwake: vi.fn(),
        releaseKeepAwake,
      },
    };

    expect(releaseSystemKeepAwake()).toEqual({ ok: true });
    expect(releaseKeepAwake).toHaveBeenCalledOnce();
  });

  it("surfaces permission/API failures clearly", () => {
    (globalThis as unknown as { chrome: Partial<typeof chrome> }).chrome = {
      power: {
        requestKeepAwake: () => {
          throw new Error("power permission missing");
        },
        releaseKeepAwake: vi.fn(),
      },
    };

    expect(requestSystemKeepAwake()).toEqual({ ok: false, error: "power permission missing" });
  });
});
