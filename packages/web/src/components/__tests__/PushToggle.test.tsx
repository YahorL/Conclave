import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// vi.mock is hoisted above const declarations — vi.hoisted makes `push` exist first.
const push = vi.hoisted(() => ({
  pushSupported: vi.fn(() => true),
  pushPermission: vi.fn<() => NotificationPermission>(() => "default"),
  isPushEnabled: vi.fn(async () => false),
  enablePush: vi.fn(async () => undefined),
  disablePush: vi.fn(async () => undefined),
}));
vi.mock("../../lib/push.js", () => push);

import { StatusStrip } from "../StatusStrip.js";

describe("push toggle", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    push.pushSupported.mockReturnValue(true);
    push.pushPermission.mockReturnValue("default");
    push.isPushEnabled.mockResolvedValue(false);
  });

  it("renders off and enables on click", async () => {
    render(<StatusStrip />);
    const btn = await screen.findByTestId("push-toggle");
    expect(btn.textContent).toContain("notifications off");
    fireEvent.click(btn);
    await waitFor(() => expect(push.enablePush).toHaveBeenCalled());
    await waitFor(() => expect(btn.textContent).toContain("notifications on"));
  });

  it("renders on and disables on click", async () => {
    push.isPushEnabled.mockResolvedValue(true);
    render(<StatusStrip />);
    const btn = await screen.findByTestId("push-toggle");
    await waitFor(() => expect(btn.textContent).toContain("notifications on"));
    fireEvent.click(btn);
    await waitFor(() => expect(push.disablePush).toHaveBeenCalled());
  });

  it("is disabled when the browser has denied permission", async () => {
    push.pushPermission.mockReturnValue("denied");
    render(<StatusStrip />);
    const btn = (await screen.findByTestId("push-toggle")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("is hidden when push is unsupported", () => {
    push.pushSupported.mockReturnValue(false);
    render(<StatusStrip />);
    expect(screen.queryByTestId("push-toggle")).toBeNull();
  });
});
