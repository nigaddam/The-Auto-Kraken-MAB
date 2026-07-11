import { describe, expect, it } from "vitest";
import {
  buildBuySignalBody,
  buildBuySignalTitle,
  buildExecutionNotificationBody,
  buildExecutionNotificationTitle,
  isPlausibleEmailAddress,
  isSupportedExecutionWebhookUrl,
  sendBuySignalWebhook,
  sendExecutionWebhook,
  type BuySignalNotificationDetails,
  type ExecutionNotificationDetails,
} from "../src/background/execution-notify";

function makeDetails(
  overrides: Partial<ExecutionNotificationDetails> = {}
): ExecutionNotificationDetails {
  return {
    symbol: "XPL",
    lotLabel: null,
    result: "SUCCESS",
    mode: "LIVE_AUTO_CLOSE",
    reason: "Hard-loss rule triggered",
    entryPrice: 1.5,
    currentPrice: 1.4,
    currentReturnPct: -6.67,
    details: ["Row disappeared from DOM"],
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("isSupportedExecutionWebhookUrl", () => {
  it("accepts ntfy.sh URLs", () => {
    expect(isSupportedExecutionWebhookUrl("https://ntfy.sh/my-private-topic")).toBe(true);
  });

  it("rejects other hosts", () => {
    expect(isSupportedExecutionWebhookUrl("https://example.com/my-topic")).toBe(false);
    expect(isSupportedExecutionWebhookUrl("https://evil-ntfy.sh.attacker.com/x")).toBe(false);
  });

  it("rejects malformed URLs without throwing", () => {
    expect(isSupportedExecutionWebhookUrl("not-a-url")).toBe(false);
    expect(isSupportedExecutionWebhookUrl("")).toBe(false);
  });
});

describe("isPlausibleEmailAddress", () => {
  it("accepts a normal-looking email", () => {
    expect(isPlausibleEmailAddress("nitgaddam@gmail.com")).toBe(true);
  });

  it("rejects strings without an @ or domain dot", () => {
    expect(isPlausibleEmailAddress("nitgaddam")).toBe(false);
    expect(isPlausibleEmailAddress("nitgaddam@gmail")).toBe(false);
    expect(isPlausibleEmailAddress("")).toBe(false);
  });
});

describe("buildExecutionNotificationTitle", () => {
  it("labels a successful LIVE auto-close", () => {
    expect(buildExecutionNotificationTitle(makeDetails())).toBe("XPL closed (LIVE)");
  });

  it("labels a failed manual close", () => {
    expect(
      buildExecutionNotificationTitle(makeDetails({ result: "FAILURE", mode: "MANUAL" }))
    ).toBe("XPL FAILED (manual)");
  });

  it("labels an uncertain result and includes a lot label when present", () => {
    expect(
      buildExecutionNotificationTitle(makeDetails({ result: "UNCERTAIN", lotLabel: "Lot 2" }))
    ).toBe("XPL Lot 2 UNCERTAIN (LIVE)");
  });
});

describe("buildExecutionNotificationBody", () => {
  it("includes all provided fields", () => {
    const body = buildExecutionNotificationBody(makeDetails());
    expect(body).toContain("Symbol: XPL");
    expect(body).toContain("Mode: LIVE Auto-Close");
    expect(body).toContain("Result: SUCCESS");
    expect(body).toContain("Reason: Hard-loss rule triggered");
    expect(body).toContain("Entry price: 1.5");
    expect(body).toContain("Current price: 1.4");
    expect(body).toContain("Return: -6.67%");
    expect(body).toContain("Details: Row disappeared from DOM");
  });

  it("omits null fields instead of printing them blank", () => {
    const body = buildExecutionNotificationBody(
      makeDetails({ entryPrice: null, currentPrice: null, currentReturnPct: null, details: [] })
    );
    expect(body).not.toContain("Entry price");
    expect(body).not.toContain("Current price");
    expect(body).not.toContain("Return:");
    expect(body).not.toContain("Details:");
  });
});

describe("sendExecutionWebhook", () => {
  it("does nothing when the URL is empty", async () => {
    const calls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(new Response());
    };
    try {
      await sendExecutionWebhook("", makeDetails());
      expect(calls.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not call fetch for an unsupported URL", async () => {
    const calls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(new Response());
    };
    try {
      await sendExecutionWebhook("https://example.com/hook", makeDetails());
      expect(calls.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("POSTs to ntfy.sh with title/priority/tags headers and a text body", async () => {
    const calls: [string, RequestInit][] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url: unknown, init?: unknown) => {
      calls.push([url as string, init as RequestInit]);
      return Promise.resolve(new Response());
    };
    try {
      await sendExecutionWebhook("https://ntfy.sh/my-topic", makeDetails());
      expect(calls.length).toBe(1);
      const call = calls[0];
      if (!call) throw new Error("expected a fetch call");
      const [url, init] = call;
      expect(url).toBe("https://ntfy.sh/my-topic");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Title).toBe("XPL closed (LIVE)");
      expect(headers.Priority).toBe("default");
      expect(typeof init.body).toBe("string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses urgent priority for failures and uncertain outcomes", async () => {
    const calls: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url: unknown, init?: unknown) => {
      calls.push(init as RequestInit);
      return Promise.resolve(new Response());
    };
    try {
      await sendExecutionWebhook("https://ntfy.sh/my-topic", makeDetails({ result: "FAILURE" }));
      const init = calls[0];
      if (!init) throw new Error("expected a fetch call");
      const headers = init.headers as Record<string, string>;
      expect(headers.Priority).toBe("urgent");
      expect(headers.Tags).toBe("rotating_light");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adds an X-Email header when a plausible email address is provided", async () => {
    const calls: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url: unknown, init?: unknown) => {
      calls.push(init as RequestInit);
      return Promise.resolve(new Response());
    };
    try {
      await sendExecutionWebhook("https://ntfy.sh/my-topic", makeDetails(), "nitgaddam@gmail.com");
      const init = calls[0];
      if (!init) throw new Error("expected a fetch call");
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Email"]).toBe("nitgaddam@gmail.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("omits the X-Email header when no email address is provided", async () => {
    const calls: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url: unknown, init?: unknown) => {
      calls.push(init as RequestInit);
      return Promise.resolve(new Response());
    };
    try {
      await sendExecutionWebhook("https://ntfy.sh/my-topic", makeDetails());
      const init = calls[0];
      if (!init) throw new Error("expected a fetch call");
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Email"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("omits the X-Email header when the email address is implausible", async () => {
    const calls: RequestInit[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url: unknown, init?: unknown) => {
      calls.push(init as RequestInit);
      return Promise.resolve(new Response());
    };
    try {
      await sendExecutionWebhook("https://ntfy.sh/my-topic", makeDetails(), "not-an-email");
      const init = calls[0];
      if (!init) throw new Error("expected a fetch call");
      const headers = init.headers as Record<string, string>;
      expect(headers["X-Email"]).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("swallows fetch errors instead of throwing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("network down"));
    try {
      await expect(
        sendExecutionWebhook("https://ntfy.sh/my-topic", makeDetails())
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function makeBuySignalDetails(
  overrides: Partial<BuySignalNotificationDetails> = {}
): BuySignalNotificationDetails {
  return {
    symbol: "SOL",
    currentPrice: 150.25,
    smaFast: 148.1,
    smaSlow: 145.0,
    consecutiveClosesAboveSmaFast: 2,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe("buildBuySignalTitle / buildBuySignalBody", () => {
  it("clearly labels it as a BUY SIGNAL, distinct from a close notification", () => {
    expect(buildBuySignalTitle(makeBuySignalDetails())).toBe("BUY SIGNAL: SOL");
  });

  it("includes the pattern, prices, and an explicit no-order-placed disclaimer", () => {
    const body = buildBuySignalBody(makeBuySignalDetails());
    expect(body).toContain("Symbol: SOL");
    expect(body).toContain("Golden cross");
    expect(body).toContain("Current price: 150.25");
    expect(body).toContain("SMA7: 148.1");
    expect(body).toContain("SMA30: 145");
    expect(body).toContain("Informational only");
  });
});

describe("sendBuySignalWebhook", () => {
  it("POSTs with a distinct title/tag/priority from execution notifications", async () => {
    const calls: [string, RequestInit][] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url: unknown, init?: unknown) => {
      calls.push([url as string, init as RequestInit]);
      return Promise.resolve(new Response());
    };
    try {
      await sendBuySignalWebhook("https://ntfy.sh/my-topic", makeBuySignalDetails());
      const call = calls[0];
      if (!call) throw new Error("expected a fetch call");
      const [url, init] = call;
      expect(url).toBe("https://ntfy.sh/my-topic");
      const headers = init.headers as Record<string, string>;
      expect(headers.Title).toBe("BUY SIGNAL: SOL");
      expect(headers.Priority).toBe("high");
      expect(headers.Tags).toBe("moneybag");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does nothing when the URL is empty or unsupported", async () => {
    const calls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(new Response());
    };
    try {
      await sendBuySignalWebhook("", makeBuySignalDetails());
      await sendBuySignalWebhook("https://example.com/hook", makeBuySignalDetails());
      expect(calls.length).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("swallows fetch errors instead of throwing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("network down"));
    try {
      await expect(
        sendBuySignalWebhook("https://ntfy.sh/my-topic", makeBuySignalDetails())
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
