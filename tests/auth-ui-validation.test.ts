import { test } from "node:test";
import assert from "node:assert/strict";
import {
  passwordRequirements,
  passwordStrength,
  validateConfirmPassword,
  validateEmail,
  validateFullName,
  validateLoginPassword,
  validateSignupPassword,
  validateVerificationCode,
} from "../src/modules/identity/ui/auth-validation";

test("auth-validation: full name and email checks", () => {
  assert.equal(validateFullName(""), "Enter your full name.");
  assert.equal(validateFullName("A"), "Full name must be at least 2 characters.");
  assert.equal(validateFullName("Priya Mehta"), null);

  assert.equal(validateEmail("  "), "Enter your email address.");
  assert.equal(
    validateEmail("not-an-email"),
    "Enter a valid email address, such as name@academy.com.",
  );
  assert.equal(validateEmail("priya@greenfield.example"), null);
  assert.equal(validateLoginPassword(""), "Enter your password.");
  assert.equal(validateLoginPassword("any-password"), null);
});

test("auth-validation: signup password follows Sportozen NIST-aligned policy", () => {
  assert.equal(validateSignupPassword(""), "Create a password.");
  assert.match(validateSignupPassword("short") ?? "", /12 characters/);
  assert.match(
    validateSignupPassword("Badminton12345") ?? "",
    /easy to guess/,
  );
  assert.match(
    validateSignupPassword("arjun.rao-secure-99", {
      name: "Arjun Rao",
      email: "arjun@academy.com",
    }) ?? "",
    /email address/,
  );
  const strong = "cobalt-meadow-orbit-94";
  assert.equal(
    validateSignupPassword(strong, {
      name: "Priya Mehta",
      email: "priya@academy.com",
    }),
    null,
  );

  const reqs = passwordRequirements(strong, {
    name: "Priya Mehta",
    email: "priya@academy.com",
  });
  assert.deepEqual(
    reqs.map((r) => [r.id, r.met]),
    [
      ["length", true],
      ["strength", true],
      ["personal", true],
    ],
  );
});

test("auth-validation: confirm password requires match", () => {
  assert.equal(
    validateConfirmPassword("cobalt-meadow-orbit-94", ""),
    "Confirm your password.",
  );
  assert.equal(
    validateConfirmPassword("cobalt-meadow-orbit-94", "cobalt-meadow-orbit-95"),
    "Passwords do not match.",
  );
  assert.equal(
    validateConfirmPassword("cobalt-meadow-orbit-94", "cobalt-meadow-orbit-94"),
    null,
  );
});

test("auth-validation: passwordStrength aligns with server policy", () => {
  assert.deepEqual(passwordStrength(""), {
    level: "empty",
    score: 0,
    label: "",
  });
  assert.equal(passwordStrength("short").level, "weak");
  assert.equal(passwordStrength("Sportozen12345").level, "weak");
  assert.equal(passwordStrength("aaaaaaaaaaaa").level, "weak");
  assert.equal(
    passwordStrength("priya-secure-99", {
      name: "Priya Mehta",
      email: "priya@academy.com",
    }).level,
    "weak",
  );
  assert.equal(passwordStrength("Racket#99").level, "fair");
  assert.equal(passwordStrength("kestrelcourt9").level, "good");
  assert.equal(passwordStrength("cobalt-meadow-orbit-94").level, "strong");
});

test("auth-validation: 6-digit email verification code check", () => {
  assert.equal(
    validateVerificationCode(""),
    "Enter the 6-digit verification code.",
  );
  assert.equal(
    validateVerificationCode("4829"),
    "Enter all 6 digits from your verification email.",
  );
  assert.equal(validateVerificationCode("482910"), null);
});
