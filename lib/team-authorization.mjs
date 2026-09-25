/** Only exact, explicitly configured email addresses may access team data. */
export function isAuthorizedTeamEmail(email, configuredEmails) {
  if (typeof email !== "string" || typeof configuredEmails !== "string") {
    return false;
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes("@")) return false;

  return configuredEmails.split(",").some((candidate) => {
    const allowedEmail = candidate.trim().toLowerCase();
    return allowedEmail.includes("@") && allowedEmail === normalizedEmail;
  });
}
