// @desc Mention gate — classify incoming Discord messages as respond, inbox_notify, or inbox

export type MessageClassification = "respond" | "inbox_notify" | "inbox";

export function classifyMessage(params: {
  isDM: boolean;
  isMentioned: boolean;
  isReplyToBot: boolean;
  requireMention: boolean;
}): MessageClassification {
  // DM → direct trigger (same as user_input)
  if (params.isDM) return "respond";
  // Guild @mention or reply → inbox with notification + context
  if (params.isMentioned || params.isReplyToBot) return "inbox_notify";
  // Guild non-mention: if requireMention is off, also notify
  if (!params.requireMention) return "inbox_notify";
  // Default guild messages → silent inbox
  return "inbox";
}
