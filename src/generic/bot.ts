import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "openclaw/plugin-sdk";
import type { GenericChannelConfig, GenericMessageContext, InboundMessage } from "./types.js";
import { getGenericRuntime } from "./runtime.js";
import { createGenericReplyDispatcher } from "./reply-dispatcher.js";

export function parseGenericMessage(message: InboundMessage): GenericMessageContext {
  return {
    chatId: message.chatId,
    messageId: message.messageId,
    senderId: message.senderId,
    senderName: message.senderName,
    chatType: message.chatType,
    content: message.content,
    contentType: message.messageType,
    mediaUrl: message.mediaUrl,
    mimeType: message.mimeType,
    parentId: message.parentId,
  };
}

export async function handleGenericMessage(params: {
  cfg: OpenClawConfig;
  message: InboundMessage;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
}): Promise<void> {
  const { cfg, message, runtime, chatHistories } = params;
  const genericCfg = cfg.channels?.["generic-channel"] as GenericChannelConfig | undefined;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const ctx = parseGenericMessage(message);
  const isGroup = ctx.chatType === "group";

  log(`generic: received message from ${ctx.senderId} in ${ctx.chatId} (${ctx.chatType})`);

  const historyLimit = Math.max(
    0,
    genericCfg?.historyLimit ?? cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
  );

  // Check DM policy
  if (!isGroup) {
    const dmPolicy = genericCfg?.dmPolicy ?? "open";
    const allowFrom = genericCfg?.allowFrom ?? [];

    if (dmPolicy === "allowlist" && allowFrom.length > 0) {
      const allowed = allowFrom.includes(ctx.senderId);
      if (!allowed) {
        log(`generic: sender ${ctx.senderId} not in DM allowlist`);
        return;
      }
    }
  }

  try {
    const core = getGenericRuntime();

    // Build target identifiers
    const genericFrom = `generic:${ctx.senderId}`;
    const genericTo = isGroup ? `chat:${ctx.chatId}` : `user:${ctx.senderId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "generic-channel",
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? ctx.chatId : ctx.senderId,
      },
    });

    const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup
      ? `Generic message in group ${ctx.chatId}`
      : `Generic DM from ${ctx.senderId}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `generic:message:${ctx.chatId}:${ctx.messageId}`,
    });

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);

    // Build message body with sender name
    const speaker = ctx.senderName ?? ctx.senderId;
    let messageBody = `${speaker}: ${ctx.content}`;

    // Handle media messages - include media URL in the message body for agent context
    if (ctx.mediaUrl && (ctx.contentType === "image" || ctx.contentType === "voice" || ctx.contentType === "audio")) {
      let mediaLabel = "🔊 Audio";
      if (ctx.contentType === "image") {
        mediaLabel = "🖼️ Image";
      } else if (ctx.contentType === "voice") {
        mediaLabel = "🎤 Voice";
      }
      messageBody = `${speaker}: [${mediaLabel}] ${ctx.content || "(no caption)"}\nMedia URL: ${ctx.mediaUrl}`;
    }
    log(`generic: message body: ${messageBody}`);
    // Handle quoted/reply messages
    if (ctx.parentId) {
      messageBody = `[Replying to message ${ctx.parentId}]\n\n${messageBody}`;
    }

    const envelopeFrom = isGroup ? `${ctx.chatId}:${ctx.senderId}` : ctx.senderId;

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Generic",
      from: envelopeFrom,
      timestamp: new Date(message.timestamp),
      envelope: envelopeOptions,
      body: messageBody,
    });

    let combinedBody = body;
    const historyKey = isGroup ? ctx.chatId : undefined;

    // Add history for group messages
    if (isGroup && historyKey && chatHistories) {
      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
        currentMessage: combinedBody,
        formatEntry: (entry) =>
          core.channel.reply.formatAgentEnvelope({
            channel: "Generic",
            from: `${ctx.chatId}:${entry.sender}`,
            timestamp: entry.timestamp,
            body: entry.body,
            envelope: envelopeOptions,
          }),
      });
    }

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      RawBody: ctx.content,
      CommandBody: ctx.content,
      From: genericFrom,
      To: genericTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? ctx.chatId : undefined,
      SenderName: ctx.senderName ?? ctx.senderId,
      SenderId: ctx.senderId,
      Provider: "generic-channel" as const,
      Surface: "generic-channel" as const,
      MessageSid: ctx.messageId,
      Timestamp: message.timestamp,
      CommandAuthorized: true,
      OriginatingChannel: "generic-channel" as const,
      OriginatingTo: genericTo,
    });

    const { dispatcher, replyOptions, markDispatchIdle } = createGenericReplyDispatcher({
      cfg,
      agentId: route.agentId,
      runtime: runtime as RuntimeEnv,
      chatId: ctx.chatId,
      replyToMessageId: ctx.messageId,
    });

    log(`generic: dispatching to agent (session=${route.sessionKey})`);

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    markDispatchIdle();

    // Clear history after successful dispatch
    if (isGroup && historyKey && chatHistories) {
      clearHistoryEntriesIfEnabled({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
      });
    }

    log(`generic: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`);
  } catch (err) {
    error(`generic: failed to dispatch message: ${String(err)}`);
  }
}
