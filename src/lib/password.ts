// Client-side password policy, kept in lockstep with the Supabase Auth
// settings (min length + required character classes). Supabase is the
// server-side source of truth — this mirrors the rules so the UI can show
// requirements live and reject obviously-bad passwords before a round-trip.
//
// Policy: minimum 12 characters, with an uppercase letter, a lowercase
// letter, a number, and a symbol.

export const PASSWORD_MIN_LENGTH = 12;

export interface PasswordRule {
  id: string;
  label: string;
  test: (pw: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  { id: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: pw => pw.length >= PASSWORD_MIN_LENGTH },
  { id: "lower", label: "A lowercase letter (a–z)", test: pw => /[a-z]/.test(pw) },
  { id: "upper", label: "An uppercase letter (A–Z)", test: pw => /[A-Z]/.test(pw) },
  { id: "number", label: "A number (0–9)", test: pw => /[0-9]/.test(pw) },
  // Anything non-alphanumeric counts as a symbol — a superset of Supabase's
  // symbol group, so the client never rejects a password the server accepts.
  { id: "symbol", label: "A symbol (! @ # $ % …)", test: pw => /[^A-Za-z0-9]/.test(pw) },
];

export interface PasswordCheck {
  valid: boolean;
  unmet: PasswordRule[];
}

export const validatePassword = (pw: string): PasswordCheck => {
  const unmet = PASSWORD_RULES.filter(r => !r.test(pw));
  return { valid: unmet.length === 0, unmet };
};

const POLICY_SENTENCE = `Use at least ${PASSWORD_MIN_LENGTH} characters with an uppercase letter, a lowercase letter, a number, and a symbol.`;

/**
 * Turn a Supabase auth error into a readable message for the password UI.
 * Covers the two server-side rejections the client can't fully pre-empt:
 * leaked-password (HaveIBeenPwned) and the weak-password policy check.
 */
export const passwordErrorMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = (error as { code?: string } | null)?.code ?? "";
  const msg = raw.toLowerCase();

  if (msg.includes("pwned") || msg.includes("leaked") || msg.includes("data breach") || msg.includes("known to be weak") || msg.includes("compromis")) {
    return "That password has turned up in a known data breach. Please pick a different one.";
  }
  if (code === "weak_password" || msg.includes("weak") || msg.includes("password should") || msg.includes("does not meet") || msg.includes("required characters")) {
    return `That password doesn't meet the requirements. ${POLICY_SENTENCE}`;
  }
  if (msg.includes("different from the old") || msg.includes("should be different") || msg.includes("same password")) {
    return "Your new password must be different from your current one.";
  }
  if (code === "session_not_found" || msg.includes("session") || msg.includes("not authenticated") || msg.includes("jwt")) {
    return "Your session expired. Please sign in again, then change your password.";
  }
  return raw || "Couldn't update the password. Please try again.";
};

/** Friendlier text for the sign-in screen; UX otherwise unchanged. */
export const signInErrorMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const msg = raw.toLowerCase();
  if (msg.includes("invalid login credentials") || msg.includes("invalid credentials")) {
    return "That email or password is incorrect.";
  }
  if (msg.includes("email not confirmed")) {
    return "This account isn't confirmed yet — ask your administrator to confirm it.";
  }
  if (msg.includes("too many") || msg.includes("rate limit")) {
    return "Too many attempts. Please wait a minute and try again.";
  }
  return raw || "Sign-in failed. Please try again.";
};
