/** Telegram mantiene typing per circa 5 secondi: rinnova senza bloccare pi. */
export function startTyping(telegram, chatId, signal, intervalMs = 4000) {
  const controller = new AbortController();
  let pending = false;
  let timer;
  const stop = () => {
    clearInterval(timer);
    controller.abort();
    signal?.removeEventListener("abort", stop);
  };
  const tick = async () => {
    if (controller.signal.aborted || pending) return;
    pending = true;
    try {
      await telegram.sendTyping(chatId, AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]));
    } catch { /* Indicatore best effort: un errore non deve impedire la risposta. */ }
    finally { pending = false; }
  };
  if (signal?.aborted) { stop(); return stop; }
  signal?.addEventListener("abort", stop, { once: true });
  timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();
  return stop;
}
