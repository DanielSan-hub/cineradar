const EMAIL_HEADER = "oai-authenticated-user-email";
const FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";

/** Parse only the identity headers documented by ChatGPT Sites. */
export function chatGPTUserFromHeaders(requestHeaders) {
  const email = requestHeaders.get(EMAIL_HEADER)?.trim();
  if (!email || !email.includes("@")) return null;

  const nameHeader = requestHeaders.get(FULL_NAME_HEADER)?.trim();
  let fullName = nameHeader || null;
  if (fullName && requestHeaders.get(FULL_NAME_ENCODING_HEADER) === "percent-encoded-utf-8") {
    try {
      fullName = decodeURIComponent(fullName);
    } catch {
      fullName = null;
    }
  }

  return { email, fullName, displayName: fullName || email };
}
