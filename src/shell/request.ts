/**
 * One place for what a failed request says to a person (UX Wave 3). A request that never reached the server, or that
 * came back as something other than JSON (a proxy page, a crash), used to surface as the browser's own wording
 * ("Failed to fetch", "Unexpected token <"). The server's own sentence is still shown whenever the server sent one.
 */
export const NETWORK_MESSAGE = "Couldn’t reach the server. Check your connection, then try again. Nothing was changed.";
export async function sendRequest(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw Object.assign(new Error(NETWORK_MESSAGE), { code: "NETWORK" });
  }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    throw Object.assign(
      new Error(`The server sent a reply this page could not read (status ${response.status}). Try again in a moment.`),
      { code: "BAD_RESPONSE", status: response.status },
    );
  }
}
