import type { OutboxEmailPayload } from "../../infrastructure/email/seal";
import { OTP_TTL_MS, RESET_TTL_MS } from "./onboarding-policy";

/**
 * The two transactional emails. Plain, short and free of tracking; the code or link is the only secret in them.
 * The text part is authoritative; the HTML part carries the same words.
 */
const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const minutes = (ms: number) => Math.round(ms / 60_000);

export function verificationEmail(input: {
  to: string;
  name: string;
  code: string;
}): OutboxEmailPayload {
  const greeting = input.name.trim() ? `Hi ${input.name.trim()},` : "Hi,";
  const lines = [
    greeting,
    "",
    `Your Sportozen verification code is ${input.code}.`,
    `It expires in ${minutes(OTP_TTL_MS)} minutes and can be used once.`,
    "",
    "If you did not create a Sportozen account, you can ignore this email; nothing will happen without this code.",
  ];
  return {
    to: input.to,
    subject: "Your Sportozen verification code",
    text: lines.join("\n"),
    html: `<p>${escapeHtml(greeting)}</p><p>Your Sportozen verification code is <strong style="font-size:1.25em;letter-spacing:0.15em">${escapeHtml(input.code)}</strong>.</p><p>It expires in ${minutes(OTP_TTL_MS)} minutes and can be used once.</p><p>If you did not create a Sportozen account, you can ignore this email; nothing will happen without this code.</p>`,
    tags: { kind: "email-verification" },
  };
}

export function passwordResetEmail(input: {
  to: string;
  name: string;
  link: string;
}): OutboxEmailPayload {
  const greeting = input.name.trim() ? `Hi ${input.name.trim()},` : "Hi,";
  const lines = [
    greeting,
    "",
    "Someone asked to reset the password of your Sportozen account. Open this link to choose a new password:",
    input.link,
    "",
    `The link expires in ${minutes(RESET_TTL_MS)} minutes and can be used once. If your account uses an authenticator app you will be asked for a code; the reset does not remove it.`,
    "If you did not ask for this, ignore this email: your password has not changed.",
  ];
  return {
    to: input.to,
    subject: "Reset your Sportozen password",
    text: lines.join("\n"),
    html: `<p>${escapeHtml(greeting)}</p><p>Someone asked to reset the password of your Sportozen account.</p><p><a href="${escapeHtml(input.link)}">Choose a new password</a></p><p>The link expires in ${minutes(RESET_TTL_MS)} minutes and can be used once. If your account uses an authenticator app you will be asked for a code; the reset does not remove it.</p><p>If you did not ask for this, ignore this email: your password has not changed.</p>`,
    tags: { kind: "password-reset" },
  };
}
