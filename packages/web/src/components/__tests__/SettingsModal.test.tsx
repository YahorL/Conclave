import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "../Sidebar.js";
import { useConclaveStore } from "../../store/useConclaveStore.js";

describe("settings modal / theme switcher", () => {
  beforeEach(() => {
    localStorage.clear();
    useConclaveStore.getState().reset();
    useConclaveStore.getState().setTheme("black");
  });

  it("gear opens the modal; segmented control reflects and switches the theme", async () => {
    render(<Sidebar />);
    expect(screen.queryByTestId("settings-modal")).toBeNull();
    await userEvent.click(screen.getByTestId("settings-open"));
    expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
    expect(screen.getByTestId("theme-black")).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByTestId("theme-teal"));
    expect(useConclaveStore.getState().theme).toBe("teal");
    expect(document.documentElement.dataset.theme).toBe("teal");
    expect(screen.getByTestId("theme-teal")).toHaveAttribute("aria-pressed", "true");
  });

  it("closes on Escape and on backdrop click", async () => {
    render(<Sidebar />);
    await userEvent.click(screen.getByTestId("settings-open"));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("settings-modal")).toBeNull();

    await userEvent.click(screen.getByTestId("settings-open"));
    await userEvent.click(screen.getByTestId("settings-backdrop"));
    expect(screen.queryByTestId("settings-modal")).toBeNull();
  });
});
