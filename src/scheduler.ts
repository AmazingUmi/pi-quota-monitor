export class RefreshScheduler {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private intervalMs: number,
    private readonly callback: () => void | Promise<void>,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => {
      void Promise.resolve(this.callback()).catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
  }

  updateInterval(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.start();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
