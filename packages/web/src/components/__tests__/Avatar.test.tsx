import { render, screen } from "@testing-library/react";
import { Avatar } from "../Avatar.js";

it("renders agent initials in a square", () => {
  render(<Avatar name="claude-code" kind="agent" />);
  // "claude-code" -> two words -> first letter of each
  expect(screen.getByText("CC")).toBeInTheDocument();
});
