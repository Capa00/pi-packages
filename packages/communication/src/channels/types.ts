import type { ChannelId } from "../contacts/types.js";

export interface IncomingMessage {
  channel: ChannelId;
  senderAddress: string;
  conversationId: string;
  messageId: string;
  text: string;
}

export interface OutgoingMessage {
  recipientAddress: string;
  text: string;
}

/** Contratto preliminare: il servizio applica le autorizzazioni prima di usare pi. */
export interface ChannelAdapter {
  readonly id: ChannelId;
  start(onMessage: (message: IncomingMessage) => Promise<void>): Promise<void>;
  send(message: OutgoingMessage): Promise<{ messageId: string }>;
  stop(): Promise<void>;
}
