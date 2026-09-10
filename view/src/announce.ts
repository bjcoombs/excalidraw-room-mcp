/**
 * Announcing pending @claude mentions into the chat.
 *
 * A note written on the canvas is shown to the reader and to the model, but in
 * a host whose chat only runs tools when prompted nothing acts on it: the
 * widget can see the note and the model never hears about it. `sendMessage` is
 * the one path back into the conversation, so the status bar carries a button
 * that takes it.
 *
 * The button is the whole mechanism. Claude Desktop drafts a `ui/message` into
 * the composer rather than sending it, whether it came from a timer or from a
 * click, so a widget that announced on its own interval produced a draft
 * nobody asked for and an announcement that arrived only when the person
 * pressed Enter. One press, one message, counted from what is pending right
 * now - which is also what makes the count right: the old path counted the ids
 * a widget had just claimed, and two notes read as "There are 1".
 *
 * The words of the notes are deliberately left out, and so is the scope rule.
 * The words are a stranger's text, and a message that reaches the model as a
 * user turn is the one place where quoting them would carry the most weight;
 * the model reads them from the room's own mention tools, inside the
 * untrusted block, with the scope rule attached. The rule belongs there, not
 * in the composer a person types into.
 *
 * Nothing in this module throws. The caller is a click handler that must leave
 * the bar in a state the reader can act on however the host answers.
 */

/**
 * What the chat is told: that there are mentions to read, and how many.
 * Nothing else.
 *
 * The sentence lands in a person's own composer, so it is written the way
 * they would write it. It used to name the tool that reads the mentions,
 * which is API surface rather than a sentence anyone types; the model already
 * knows that tool from the server instructions at initialize, so naming it
 * here bought nothing and cost the message its plain voice. No tool name
 * appears in this module.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/91
 *
 * The scope rule is absent for the same reason it always was: it is
 * model-facing enforcement text and it already travels with every mention
 * result.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/77
 *
 * Each form is one whole literal: number agreement runs through the sentence
 * ("mention"/"mentions"), and a concatenation inside a sentence is a place for
 * a space to go missing.
 */
export function announcementText(count: number): string {
  return count === 1
    ? "Please read the @claude mention in the Excalidraw room."
    : `Please read the ${count} @claude mentions in the Excalidraw room.`;
}

/** The button's label: what pressing it will do, and how much of it there is. */
export function answerLabel(count: number): string {
  return `Answer ${count} @claude mention${count === 1 ? "" : "s"}`;
}

/**
 * What the bar says when the host would not take the message. The button stays
 * next to it: a host that refuses once may take the next press, and the
 * mentions are still pending either way.
 */
export const ANNOUNCEMENT_REFUSED_TEXT = "announcement refused by this host";

/** The part of `App` this module uses. A fake with one method stands in for it under test. */
export interface AnnouncerHost {
  sendMessage(params: { role: "user"; content: { type: "text"; text: string }[] }): Promise<{ isError?: boolean } | undefined>;
}

/** Whether the message reached the chat. */
export type SendOutcome = "sent" | "refused";

/**
 * Put the announcement for `count` pending mentions into the chat.
 *
 * A host may refuse by answering `isError` or by rejecting the request
 * outright - it has no `ui/message` at all - and both mean the same thing to
 * the reader, so both come back as `refused` rather than as an exception.
 */
export async function sendAnnouncement(app: AnnouncerHost, count: number): Promise<SendOutcome> {
  try {
    const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: announcementText(count) }] });
    return result?.isError === true ? "refused" : "sent";
  } catch {
    return "refused";
  }
}
