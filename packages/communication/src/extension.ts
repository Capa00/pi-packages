import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Entry point pi: nessuna connessione o processo avviato durante il caricamento. */
export default function communication(pi: ExtensionAPI): void {
  pi.registerCommand("communication-status", {
    description: "Mostra lo stato del package comunicazione",
    handler: async (_args, ctx) => {
      const status = "Communication: servizio Telegram disponibile (ricezione, risposte e outbound con conferma); avvio separato. Strumenti outbound disponibili nelle sessioni gestite dal servizio.";
      if (ctx.hasUI) {
        ctx.ui.notify(status, "info");
      } else {
        pi.sendMessage({
          customType: "communication-status",
          content: status,
          display: true,
        }, { triggerTurn: false });
      }
    },
  });
}
