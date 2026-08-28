export type ViteHostEnvironment = {
  REPLIT_DEV_DOMAIN?: string;
  REPLIT_DOMAINS?: string;
  VITE_ALLOWED_HOSTS?: string;
};

export function resolveAllowedHosts(env: ViteHostEnvironment): string[] {
  const replitPreviewHosts = [
    env.REPLIT_DEV_DOMAIN ?? "",
    ...(env.REPLIT_DOMAINS ?? "").split(","),
  ]
    .map((host) => host.trim())
    .filter(Boolean);
  const configuredAllowedHosts = (env.VITE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const allowedHosts = configuredAllowedHosts.length > 0
    ? configuredAllowedHosts
    : ["localhost", "127.0.0.1"];
  return [...allowedHosts, ...replitPreviewHosts];
}