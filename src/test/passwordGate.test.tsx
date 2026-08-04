// The forced-password gate decides whether 37 people can reach the app at all,
// so its decision table is worth pinning down. These tests exercise the real
// component against a stubbed auth context — the parts that would actually bite
// are the boundary cases (missing metadata, a session still loading, an
// unflagged user), not the happy path.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { User } from "@supabase/supabase-js";

// The component pulls everything it needs from useAuth, so stubbing that module
// exercises the real render logic without a live Supabase.
const authState = {
  user: null as User | null,
  completePasswordSetup: vi.fn(),
  signOut: vi.fn(),
};
vi.mock("@/lib/auth", () => ({ useAuth: () => authState }));

const { ForcePasswordSetup } = await import("@/components/ForcePasswordSetup");

const asUser = (appMetadata: Record<string, unknown>): User =>
  ({ id: "u1", email: "lo@hometownlend.com", app_metadata: appMetadata } as unknown as User);

/** Mirrors the flag read in AuthProvider — the gate's actual predicate. */
const mustSetPassword = (user: User | null) =>
  (user?.app_metadata as { must_set_password?: unknown } | undefined)?.must_set_password === true;

describe("must_set_password — the flag the gate turns on", () => {
  it("gates only on a literal true", () => {
    expect(mustSetPassword(asUser({ must_set_password: true }))).toBe(true);
  });

  it("does NOT gate once the flag is cleared to false", () => {
    expect(mustSetPassword(asUser({ must_set_password: false }))).toBe(false);
  });

  it("does NOT gate an account that never had the flag", () => {
    // Every pre-existing account, admins included. A bug here would lock the
    // whole company out of a tool nobody could then fix from the UI.
    expect(mustSetPassword(asUser({}))).toBe(false);
    expect(mustSetPassword(asUser({ provider: "email" }))).toBe(false);
  });

  it("does NOT gate a signed-out visitor", () => {
    expect(mustSetPassword(null)).toBe(false);
  });

  it("ignores truthy-but-not-true values, so a stray string can't gate anyone", () => {
    // Admin API writes JSON; a hand-edited "false" string would be truthy and
    // would otherwise trap someone permanently.
    expect(mustSetPassword(asUser({ must_set_password: "false" }))).toBe(false);
    expect(mustSetPassword(asUser({ must_set_password: 1 }))).toBe(false);
  });
});

describe("ForcePasswordSetup", () => {
  beforeEach(() => {
    authState.user = asUser({ must_set_password: true });
    authState.completePasswordSetup = vi.fn().mockResolvedValue(undefined);
    authState.signOut = vi.fn();
  });

  it("names the account being set up, so a shared computer can't confuse people", () => {
    render(<ForcePasswordSetup />);
    expect(screen.getByText("lo@hometownlend.com")).toBeInTheDocument();
  });

  it("keeps submit disabled until the password is valid AND confirmed", async () => {
    render(<ForcePasswordSetup />);
    const submit = screen.getByRole("button", { name: /save and continue/i });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Quarry-Lantern-Meadow7742!" } });
    expect(submit).toBeDisabled(); // valid, but unconfirmed

    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Quarry-Lantern-Meadow7742!" } });
    expect(submit).toBeEnabled();
  });

  it("refuses a mismatch and says so", async () => {
    render(<ForcePasswordSetup />);
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "Quarry-Lantern-Meadow7742!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "Quarry-Lantern-Meadow7743!" } });
    expect(screen.getByText(/don't match/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save and continue/i })).toBeDisabled();
  });

  it("hands the new password to completePasswordSetup", async () => {
    render(<ForcePasswordSetup />);
    const pw = "Quarry-Lantern-Meadow7742!";
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: pw } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: pw } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
    await waitFor(() => expect(authState.completePasswordSetup).toHaveBeenCalledWith(pw));
  });

  it("says the password DID change when only the flag-clear failed", async () => {
    // The dangerous message here is a generic failure: the old password is gone
    // by this point, so "something went wrong" would have someone retyping a
    // password that no longer works.
    authState.completePasswordSetup = vi.fn().mockRejectedValue(new Error("FLAG_NOT_CLEARED: boom"));
    render(<ForcePasswordSetup />);
    const pw = "Quarry-Lantern-Meadow7742!";
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: pw } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: pw } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
    await waitFor(() => expect(screen.getByText(/password was changed/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("reports a rejected password as an error and stays on the form", async () => {
    authState.completePasswordSetup = vi.fn().mockRejectedValue(
      Object.assign(new Error("Password is known to be weak and easy to guess"), { code: "weak_password" }),
    );
    render(<ForcePasswordSetup />);
    const pw = "Quarry-Lantern-Meadow7742!";
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: pw } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: pw } });
    fireEvent.click(screen.getByRole("button", { name: /save and continue/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    // Still the form, not the "changed" screen — the password did not take.
    expect(screen.queryByText(/password was changed/i)).not.toBeInTheDocument();
  });

  it("offers a way out, so a confused person isn't trapped on this screen", () => {
    render(<ForcePasswordSetup />);
    expect(screen.getByRole("button", { name: /sign out instead/i })).toBeInTheDocument();
  });
});
