import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runWithVerify, type HealthSnapshot } from "./tool-registry.js";

describe("runWithVerify", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("runs handler directly when no verify is supplied", async () => {
    const handler = vi.fn().mockResolvedValue("done");
    const out = await runWithVerify("noop", handler);
    expect(out.result).toBe("done");
    expect(out.verify).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("success path: pre healthy -> post healthy, result unannotated", async () => {
    const verify = vi
      .fn<() => Promise<HealthSnapshot>>()
      .mockResolvedValueOnce({ healthy: true, details: "ok-pre" })
      .mockResolvedValueOnce({ healthy: true, details: "ok-post" });
    const handler = vi.fn().mockResolvedValue("did-work");

    const out = await runWithVerify("t", handler, verify);

    expect(verify).toHaveBeenCalledTimes(2);
    expect(out.result).toBe("did-work");
    expect(out.verify?.regressed).toBe(false);
    expect(out.verify?.pre.healthy).toBe(true);
    expect(out.verify?.post.healthy).toBe(true);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("regression path: pre healthy -> post unhealthy, result annotated and logged", async () => {
    const verify = vi
      .fn<() => Promise<HealthSnapshot>>()
      .mockResolvedValueOnce({ healthy: true })
      .mockResolvedValueOnce({ healthy: false, details: { error: "timeout" } });
    const handler = vi.fn().mockResolvedValue("restart attempted");

    const out = await runWithVerify("restart_mcp_server", handler, verify);

    expect(out.verify?.regressed).toBe(true);
    expect(out.result).toContain("restart attempted");
    expect(out.result).toContain("[verify] WARNING");
    expect(out.result).toContain("restart_mcp_server");
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
  });

  it("no false alarm: pre unhealthy -> post unhealthy", async () => {
    const verify = vi
      .fn<() => Promise<HealthSnapshot>>()
      .mockResolvedValueOnce({ healthy: false, details: "was broken" })
      .mockResolvedValueOnce({ healthy: false, details: "still broken" });
    const handler = vi.fn().mockResolvedValue("tried");

    const out = await runWithVerify("t", handler, verify);

    expect(out.verify?.regressed).toBe(false);
    expect(out.result).toBe("tried");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("improvement: pre unhealthy -> post healthy, no flag", async () => {
    const verify = vi
      .fn<() => Promise<HealthSnapshot>>()
      .mockResolvedValueOnce({ healthy: false })
      .mockResolvedValueOnce({ healthy: true });
    const handler = vi.fn().mockResolvedValue("fixed");

    const out = await runWithVerify("t", handler, verify);

    expect(out.verify?.regressed).toBe(false);
    expect(out.result).toBe("fixed");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("a thrown verify is captured as unhealthy with error details", async () => {
    const verify = vi
      .fn<() => Promise<HealthSnapshot>>()
      .mockResolvedValueOnce({ healthy: true })
      .mockRejectedValueOnce(new Error("boom"));
    const handler = vi.fn().mockResolvedValue("ran");

    const out = await runWithVerify("t", handler, verify);

    expect(out.verify?.regressed).toBe(true);
    expect(out.verify?.post.healthy).toBe(false);
    expect((out.verify?.post.details as { error: string }).error).toBe("boom");
    expect(out.result).toContain("[verify] WARNING");
  });

  it("calls verify before AND after handler (correct ordering)", async () => {
    const calls: string[] = [];
    const verify = vi.fn(async () => {
      calls.push("verify");
      return { healthy: true } as HealthSnapshot;
    });
    const handler = vi.fn(async () => {
      calls.push("handler");
      return "done";
    });

    await runWithVerify("t", handler, verify);

    expect(calls).toEqual(["verify", "handler", "verify"]);
  });
});
