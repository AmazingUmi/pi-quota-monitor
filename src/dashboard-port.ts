import { createServer } from "node:net";

export const DASHBOARD_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 38457;

export function isDashboardPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function portErrorMessage(port: number, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") return `端口 ${port} 已被占用，请关闭占用程序或选择其他端口。`;
  if (code === "EACCES" || code === "EPERM") return `没有权限监听端口 ${port}，请选择其他端口。`;
  return `无法监听本机端口 ${port}，请检查网络设置或选择其他端口。`;
}

/** Bind, then release: a point-in-time check, not a reservation for the next launch. */
export async function checkDashboardPort(port: number, currentPort?: number): Promise<{ available: boolean; message: string }> {
  if (!isDashboardPort(port)) throw new Error("端口须为 1024–65535 的整数。");
  if (port === currentPort) return { available: true, message: `端口 ${port} 正由当前控制台使用，可继续使用。` };
  return new Promise((resolve) => {
    const probe = createServer((socket) => socket.destroy());
    probe.once("error", (error) => resolve({ available: false, message: portErrorMessage(port, error) }));
    probe.listen({ host: DASHBOARD_HOST, port, exclusive: true }, () => {
      probe.close(() => resolve({ available: true, message: `端口 ${port} 当前可用；下次启动时仍会重新检查。` }));
    });
  });
}
