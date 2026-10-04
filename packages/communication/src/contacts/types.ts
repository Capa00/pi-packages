export type ChannelId = "telegram" | "whatsapp" | "slack" | "discord";

/** Un recapito registrato non conferisce automaticamente alcuna autorizzazione. */
export interface ContactEndpoint {
  channel: ChannelId;
  /** Identificativo stabile del provider, mai un nome visualizzato. */
  address: string;
  /** Contesto del provider, ad esempio workspace Slack o server Discord. */
  scope?: string;
  permissions: {
    canInteractWithPi: boolean;
    canReceiveMessages: boolean;
    canRequestSendMessages: boolean;
  };
}

export interface Contact {
  id: string;
  name: string;
  aliases: string[];
  endpoints: ContactEndpoint[];
  preferredChannel?: ChannelId;
}
