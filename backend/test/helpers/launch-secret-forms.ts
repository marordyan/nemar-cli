/**
 * Every form a job's token takes in the launch value, for the tests that look for a leak (contract
 * follow-up A1c, #2043).
 *
 * The launch value is the launch specification's text in base64url, and the token is inside that
 * text, so the plain token is NOT a substring of the value. A check for the plain token and for the
 * whole value then misses a leak of PART of the value, such as a log line that carries a slice of it,
 * which holds the token only in encoded form. Base64 turns three bytes into four characters, so the
 * same token is written three different ways, depending on how many bytes come before it in the text
 * (0, 1 or 2 modulo 3, which is its alignment in a group).
 *
 * A leak is also not always the whole of a form: a line may carry a slice of the token, or of an
 * aligned form. So the check forbids every run of `SECRET_WINDOW` consecutive characters of the plain
 * token and of each aligned form, as well as the whole value. A slice of that many characters or more
 * is found; a shorter one is not, and no check by substring could say otherwise without matching
 * ordinary text. `launchSecretForms` returns all of it, and one helper keeps every leak list in step.
 */

/** The width of the runs of characters that a leak check forbids: 16 characters, 12 bytes of token. */
export const SECRET_WINDOW = 16;

/**
 * The token's base64url text at each of its three alignments. An alignment's form is the characters
 * whose three-byte groups lie wholly inside the token, so the bytes around the token cannot change
 * them. The independent oracle is Node's own base64url, not the contract's encoder, so a bug in the
 * encoder cannot hide a form.
 */
export function alignedTokenForms(token: string): string[] {
  const forms: string[] = [];
  for (let before = 0; before < 3; before++) {
    // `before` bytes ahead of the token, in a text whose other bytes do not matter.
    const encoded = Buffer.from("x".repeat(before) + token, "latin1").toString("base64url");
    const from = Math.ceil(before / 3) * 4;
    const to = Math.floor((before + token.length) / 3) * 4;
    const form = encoded.slice(from, to);
    // An empty or tiny form would match nearly anything, which would make a leak check meaningless.
    if (form.length < 8) throw new Error("the token is too short to have a form of its own");
    forms.push(form);
  }
  return forms;
}

/** Every run of `SECRET_WINDOW` consecutive characters of `text`; all of it when it is shorter. */
function windowsOf(text: string): string[] {
  if (text.length <= SECRET_WINDOW) return [text];
  return Array.from({ length: text.length - SECRET_WINDOW + 1 }, (_, at) =>
    text.slice(at, at + SECRET_WINDOW),
  );
}

/**
 * What a leak check must not find: the plain token, the whole value, and every run of
 * `SECRET_WINDOW` characters of the plain token and of each of its three aligned forms.
 */
export function launchSecretForms(token: string, launchSpecEnv: string): string[] {
  const forbidden = new Set<string>([token, launchSpecEnv]);
  for (const part of [token, ...alignedTokenForms(token)]) {
    for (const run of windowsOf(part)) forbidden.add(run);
  }
  return [...forbidden];
}
